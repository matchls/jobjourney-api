import { CookieOptions } from "express";

const isProduction = () => process.env.NODE_ENV === "production";

export const AUTH_COOKIE_NAME = "token";
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export const getAuthCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: isProduction(),
  sameSite: isProduction() ? "none" : "lax",
  path: "/",
  maxAge: AUTH_COOKIE_MAX_AGE,
});

// clearCookie ne doit pas recevoir maxAge : express recalculerait "expires"
// à partir de maxAge et écraserait la date d'expiration passée nécessaire
// pour effectivement supprimer le cookie.
export const getAuthCookieClearOptions = (): CookieOptions => {
  const { maxAge, ...options } = getAuthCookieOptions();
  return options;
};

export const OAUTH_STATE_COOKIE_NAME = "oauth_state";
const OAUTH_STATE_COOKIE_MAX_AGE = 10 * 60 * 1000;

export const getOAuthStateCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: isProduction(),
  sameSite: "lax",
  path: "/",
  maxAge: OAUTH_STATE_COOKIE_MAX_AGE,
});

export const getOAuthStateCookieClearOptions = (): CookieOptions => {
  const { maxAge, ...options } = getOAuthStateCookieOptions();
  return options;
};
