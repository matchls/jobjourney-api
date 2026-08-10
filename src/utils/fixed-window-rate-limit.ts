// Compteur fixe en mémoire, réutilisable, sans dépendance externe.
//
// Extrait la mécanique déjà éprouvée par agent-rate-limit.middleware.ts
// (fenêtre fixe, balayage périodique, timer unref pour ne pas retenir le
// process) afin que le limiteur de /applications/parse-offer ne la
// recopie pas. Le middleware agent n'est volontairement PAS migré dans cette
// PR : il fonctionne, il est couvert par ses tests d'intégration, et le
// toucher élargirait le périmètre de #17 sans rien apporter.
//
// Limite assumée, identique à celle du flux agent : le compteur est local au
// process. Sur un déploiement Render multi-instance, chaque instance applique
// son propre budget. Suffisant pour la cible mono-instance actuelle,
// remplaçable par un store partagé (Redis) le jour où ça change.

interface Bucket {
  count: number;
  windowStart: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface FixedWindowRateLimiter {
  hit(key: string): RateLimitDecision;
  reset(): void;
}

export const createFixedWindowRateLimiter = (config: {
  windowMs: number;
  maxRequests: number;
  sweepIntervalMs?: number;
}): FixedWindowRateLimiter => {
  const buckets = new Map<string, Bucket>();

  const sweepTimer = setInterval(
    () => {
      const now = Date.now();
      for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart >= config.windowMs) {
          buckets.delete(key);
        }
      }
    },
    config.sweepIntervalMs ?? Math.max(config.windowMs, 60_000),
  );
  sweepTimer.unref?.();

  return {
    hit(key: string): RateLimitDecision {
      const now = Date.now();
      const bucket = buckets.get(key);

      if (!bucket || now - bucket.windowStart >= config.windowMs) {
        buckets.set(key, { count: 1, windowStart: now });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (bucket.count >= config.maxRequests) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((bucket.windowStart + config.windowMs - now) / 1000),
          ),
        };
      }

      bucket.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },

    reset(): void {
      buckets.clear();
    },
  };
};
