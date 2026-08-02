import { Response, NextFunction } from "express";
import { AgentAuthRequest } from "./agent-auth.middleware";
import { logAgentEvent } from "../utils/agent-logger";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 60;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface Bucket {
  count: number;
  windowStart: number;
}

// In-memory fixed-window limiter, keyed by the internal AgentApiKey id (never
// by the raw key or secret). Local to this process: on a multi-instance
// Render deployment each instance enforces its own 60/10min budget rather
// than a shared global one — acceptable for the single-instance V1.1 target,
// documented in README.md, and would need a shared store (Redis) to scale
// horizontally without loosening the effective limit.
const buckets = new Map<string, Bucket>();

const sweep = () => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) {
      buckets.delete(key);
    }
  }
};

const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
sweepTimer.unref?.();

export const agentRateLimit = (
  req: AgentAuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const apiKeyId = req.agentApiKeyId;

  if (!apiKeyId) {
    // This middleware must run after requireAgentAuth(); fail closed if not.
    res.status(401).json({ error: { code: "unauthorized" } });
    return;
  }

  const now = Date.now();
  const bucket = buckets.get(apiKeyId);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(apiKeyId, { count: 1, windowStart: now });
    next();
    return;
  }

  if (bucket.count >= MAX_REQUESTS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000),
    );

    logAgentEvent({
      event: "agent_rate_limit",
      result: "rate_limited",
      apiKeyId,
      apiKeyPrefix: req.agentApiKeyPrefix,
      userId: req.userId,
    });

    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({ error: { code: "rate_limited" } });
    return;
  }

  bucket.count += 1;
  next();
};

export const __resetAgentRateLimitStateForTests = (): void => {
  buckets.clear();
};
