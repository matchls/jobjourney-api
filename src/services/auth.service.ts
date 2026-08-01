import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { User } from "@prisma/client";
import prisma from "../config/prisma";
import { RegisterInput, LoginInput } from "../validators/auth.validator";
import { GoogleProfile } from "../config/google.config";

const SALT_ROUNDS = 10;

export const registerUser = async (data: RegisterInput) => {
  const existing = await prisma.user.findUnique({
    where: { email: data.email },
  });

  if (existing) {
    throw new Error("EMAIL_ALREADY_EXISTS");
  }

  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      passwordHash,
    },
  });

  return user;
};

export const loginUser = async (data: LoginInput) => {
  const user = await prisma.user.findUnique({
    where: { email: data.email },
  });

  if (!user || !user.passwordHash) {
    throw new Error("INVALID_CREDENTIALS");
  }

  const isValid = await bcrypt.compare(data.password, user.passwordHash);

  if (!isValid) {
    throw new Error("INVALID_CREDENTIALS");
  }

  return user;
};

export const generateToken = (userId: string) => {
  const secret = process.env.JWT_SECRET!;
  return jwt.sign({ userId }, secret, { expiresIn: "7d" });
};

export const generateOAuthState = () => crypto.randomBytes(32).toString("hex");

export class GoogleAccountConflictError extends Error {
  constructor() {
    super("GOOGLE_ACCOUNT_CONFLICT");
  }
}

// "linkable" seulement pour une ligne OAuth pure (jamais de mot de passe) et
// pas encore liée à un compte Google : c'est la seule situation où lier
// automatiquement est sûr. Un compte email/mot de passe existant ou déjà lié
// à un autre googleId doit toujours produire un conflit explicite plutôt
// qu'une liaison ou une fusion silencieuse (pré-hijacking par email).
const getGoogleLinkVerdict = (
  user: User,
  profile: GoogleProfile,
): "already-linked" | "conflict" | "linkable" => {
  if (user.googleId) {
    return user.googleId === profile.googleId ? "already-linked" : "conflict";
  }

  if (user.passwordHash !== null) {
    return "conflict";
  }

  return "linkable";
};

const linkExistingUserToGoogle = async (
  existingUser: User,
  profile: GoogleProfile,
): Promise<User> => {
  const verdict = getGoogleLinkVerdict(existingUser, profile);

  if (verdict === "conflict") {
    throw new GoogleAccountConflictError();
  }

  if (verdict === "already-linked") {
    return existingUser;
  }

  // Mise à jour conditionnelle et atomique : la ligne n'est modifiée que si
  // elle est encore exactement dans l'état "OAuth non lié" observé à
  // l'instant de la lecture (pas de lecture-puis-écriture non protégée).
  const { count } = await prisma.user.updateMany({
    where: { id: existingUser.id, googleId: null, passwordHash: null },
    data: {
      googleId: profile.googleId,
      name: existingUser.name ?? profile.name,
      avatarUrl: existingUser.avatarUrl ?? profile.avatarUrl,
    },
  });

  if (count === 0) {
    // La ligne a changé entre notre lecture et notre update (requête
    // concurrente) : on relit l'état réel et on réapplique les règles de
    // conflit au lieu de supposer que la liaison a réussi.
    const refreshed = await prisma.user.findUnique({
      where: { id: existingUser.id },
    });

    if (!refreshed || getGoogleLinkVerdict(refreshed, profile) !== "already-linked") {
      throw new GoogleAccountConflictError();
    }

    return refreshed;
  }

  return (await prisma.user.findUnique({ where: { id: existingUser.id } }))!;
};

export const findOrCreateGoogleUser = async (profile: GoogleProfile) => {
  const byGoogleId = await prisma.user.findUnique({
    where: { googleId: profile.googleId },
  });

  if (byGoogleId) {
    return byGoogleId;
  }

  const byEmail = await prisma.user.findFirst({
    where: { email: { equals: profile.email, mode: "insensitive" } },
  });

  if (byEmail) {
    return linkExistingUserToGoogle(byEmail, profile);
  }

  try {
    return await prisma.user.create({
      data: {
        email: profile.email,
        googleId: profile.googleId,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        passwordHash: null,
      },
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      // Course concurrente (double-clic, deux onglets) : une seule création
      // gagne la course. On ne fait confiance qu'à une correspondance exacte
      // de googleId — jamais à une simple correspondance d'email, qui
      // pourrait appartenir à un compte mot de passe ou à un autre compte
      // Google que le nôtre.
      const existing = await prisma.user.findUnique({
        where: { googleId: profile.googleId },
      });

      if (existing) {
        return existing;
      }

      throw new GoogleAccountConflictError();
    }

    throw error;
  }
};
