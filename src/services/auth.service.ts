import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
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
    if (byEmail.googleId && byEmail.googleId !== profile.googleId) {
      throw new GoogleAccountConflictError();
    }

    return prisma.user.update({
      where: { id: byEmail.id },
      data: {
        googleId: profile.googleId,
        name: byEmail.name ?? profile.name,
        avatarUrl: byEmail.avatarUrl ?? profile.avatarUrl,
      },
    });
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
    // Requêtes concurrentes (double-clic, deux onglets) : une seule création
    // gagne la course, l'autre reçoit une violation de contrainte unique.
    // On récupère l'utilisateur déjà créé plutôt que de renvoyer une erreur.
    if (error.code === "P2002") {
      const existing =
        (await prisma.user.findUnique({
          where: { googleId: profile.googleId },
        })) ??
        (await prisma.user.findFirst({
          where: { email: { equals: profile.email, mode: "insensitive" } },
        }));

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
};
