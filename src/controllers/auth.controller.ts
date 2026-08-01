import { Request, Response } from "express";
import { registerSchema, loginSchema } from "../validators/auth.validator";
import {
  registerUser,
  loginUser,
  generateToken,
  generateOAuthState,
  findOrCreateGoogleUser,
  GoogleAccountConflictError,
} from "../services/auth.service";
import prisma from "../config/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  AUTH_COOKIE_NAME,
  getAuthCookieOptions,
  getAuthCookieClearOptions,
  OAUTH_STATE_COOKIE_NAME,
  getOAuthStateCookieOptions,
  getOAuthStateCookieClearOptions,
} from "../config/cookie.config";
import {
  isGoogleConfigured,
  getGoogleOAuthClient,
  getClientUrl,
  verifyGoogleIdToken,
  InvalidGoogleAccountError,
  GOOGLE_OAUTH_SCOPES,
} from "../config/google.config";

export const register = async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const user = await registerUser(parsed.data);
    const token = generateToken(user.id);

    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    res.status(201).json({ id: user.id, email: user.email, name: user.name });
  } catch (error: any) {
    if (error.message === "EMAIL_ALREADY_EXISTS") {
      res.status(409).json({ error: "Email already in use" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
};

export const login = async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const user = await loginUser(parsed.data);
    const token = generateToken(user.id);

    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    res.status(200).json({ id: user.id, email: user.email, name: user.name });
  } catch (error: any) {
    if (error.message === "INVALID_CREDENTIALS") {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
};

export const logout = (_req: Request, res: Response) => {
  res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieClearOptions());
  res.status(200).json({ message: "Logged out" });
};

export const getMe = async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        defaultInterviewSteps: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json(user);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
};

export const googleRedirect = (_req: Request, res: Response) => {
  const clientUrl = getClientUrl();

  if (!isGoogleConfigured()) {
    res.redirect(`${clientUrl}/login?oauthError=google_not_configured`);
    return;
  }

  const state = generateOAuthState();
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, getOAuthStateCookieOptions());

  const client = getGoogleOAuthClient();
  const url = client.generateAuthUrl({
    scope: GOOGLE_OAUTH_SCOPES,
    prompt: "select_account",
    state,
  });

  res.redirect(url);
};

export const googleCallback = async (req: Request, res: Response) => {
  const clientUrl = getClientUrl();
  const redirectWithError = (code: string) => {
    res.redirect(`${clientUrl}/login?oauthError=${code}`);
  };

  // Le cookie de state n'a d'utilité qu'une seule fois : on le lit puis on le
  // supprime immédiatement, que la suite du callback réussisse ou échoue.
  const stateCookie = req.cookies[OAUTH_STATE_COOKIE_NAME];
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, getOAuthStateCookieClearOptions());

  const { code, state, error } = req.query;

  if (!isGoogleConfigured()) {
    redirectWithError("google_not_configured");
    return;
  }

  // Le state (protection CSRF) doit être validé avant même de regarder le
  // paramètre "error" : un callback forgé qui ajoute error=access_denied ne
  // doit pas pouvoir contourner la vérification de state.
  if (
    typeof state !== "string" ||
    typeof stateCookie !== "string" ||
    state !== stateCookie
  ) {
    redirectWithError("invalid_state");
    return;
  }

  if (typeof error === "string") {
    redirectWithError(
      error === "access_denied" ? "google_cancelled" : "google_oauth_failed",
    );
    return;
  }

  if (typeof code !== "string") {
    redirectWithError("google_oauth_failed");
    return;
  }

  try {
    const client = getGoogleOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      redirectWithError("google_oauth_failed");
      return;
    }

    const profile = await verifyGoogleIdToken(tokens.id_token);
    const user = await findOrCreateGoogleUser(profile);
    const token = generateToken(user.id);

    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());
    res.redirect(`${clientUrl}/dashboard`);
  } catch (err) {
    if (err instanceof GoogleAccountConflictError) {
      redirectWithError("account_conflict");
      return;
    }

    if (err instanceof InvalidGoogleAccountError) {
      redirectWithError("invalid_google_account");
      return;
    }

    // On ne logge jamais err.message : sur une erreur venant de Google (ex. un
    // échec d'échange de code via gaxios), le message peut embarquer le corps
    // de la réponse HTTP et donc des données sensibles. Seul le nom/type
    // d'erreur est loggé.
    console.error(
      "Google OAuth callback failed:",
      err instanceof Error ? err.name : "UnknownError",
    );
    redirectWithError("google_oauth_failed");
  }
};
