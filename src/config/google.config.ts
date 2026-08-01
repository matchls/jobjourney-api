import { OAuth2Client } from "google-auth-library";

export const GOOGLE_OAUTH_SCOPES = ["openid", "email", "profile"];

export const isGoogleConfigured = (): boolean =>
  Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_CALLBACK_URL,
  );

export const getClientUrl = (): string =>
  process.env.CLIENT_URL || "http://localhost:3000";

export const getGoogleOAuthClient = (): OAuth2Client =>
  new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL,
  );

export class InvalidGoogleAccountError extends Error {
  constructor() {
    super("INVALID_GOOGLE_ACCOUNT");
  }
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

// N'extrait que les infos d'identité du profil : les tokens Google (access/refresh)
// ne sont jamais retournés ni stockés au-delà de cette vérification.
export const verifyGoogleIdToken = async (
  idToken: string,
): Promise<GoogleProfile> => {
  const client = getGoogleOAuthClient();

  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new InvalidGoogleAccountError();
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name,
    avatarUrl: payload.picture,
  };
};
