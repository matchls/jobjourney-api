import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";
import { createFixedWindowRateLimiter } from "../utils/fixed-window-rate-limit";
import { logExtractionEvent } from "../utils/extraction-logger";

// Budget par utilisateur, pas par IP : la clé est l'userId issu du JWT déjà
// vérifié, donc un utilisateur ne peut pas contourner la limite en changeant
// de réseau, et deux utilisateurs derrière la même IP ne se pénalisent pas.
//
// Chaque appel consomme du quota Groq payant, d'où une limite nettement plus
// basse que celle du flux agent : coller une offre est une action manuelle,
// 20 extractions par tranche de 10 minutes couvre largement un usage réel tout
// en bornant l'abus et l'épuisement du quota.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

const limiter = createFixedWindowRateLimiter({
  windowMs: WINDOW_MS,
  maxRequests: MAX_REQUESTS,
});

export const parseOfferRateLimit = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const userId = req.userId;

  if (!userId) {
    // Ce middleware doit tourner après authenticate ; on échoue fermé si ce
    // n'est pas le cas, plutôt que de laisser passer sans compteur.
    res.status(401).json({ error: { code: "unauthorized" } });
    return;
  }

  const decision = limiter.hit(userId);

  if (!decision.allowed) {
    logExtractionEvent({
      event: "job_offer_extraction",
      result: "rate_limited",
      userId,
    });
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    res.status(429).json({ error: { code: "rate_limited" } });
    return;
  }

  next();
};

export const __resetParseOfferRateLimitStateForTests = (): void => {
  limiter.reset();
};
