import { Prisma } from "@prisma/client";

// Postgres reports a serialization failure with SQLSTATE 40001 when two
// SERIALIZABLE transactions overlap in a way that couldn't have happened in
// any serial ordering. Prisma does not expose SQLSTATE codes to the client,
// so 40001 is matched through the stable Prisma error code it maps to:
// P2034. Verified against @prisma/client 5.22 + PostgreSQL 18 for both
// places Postgres can raise it — at the offending statement (meta carries
// the model name) and at COMMIT (meta is empty) — because an SSI conflict on
// a read-then-insert sequence is frequently only detected at commit time.
// Matching on the error code rather than on the message text keeps this
// independent of Postgres' and Prisma's wording.
export const isSerializationFailure = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2034";

// Small and explicit: a serialization conflict is expected to clear within a
// couple of attempts, and anything that survives five is a real problem worth
// surfacing rather than hiding behind more retries.
export const MAX_SERIALIZATION_ATTEMPTS = 5;

// Full jitter over an exponential base (5, 10, 20, 40 ms windows), so the
// worst case adds well under 100 ms. The delay is not padding to make a test
// pass: two transactions that just aborted each other are perfectly
// synchronised, and retrying them immediately re-creates the same overlap.
// Randomising the wait is what decorrelates them; the exponential growth
// keeps a sustained burst from being retried at a fixed rate.
const BASE_RETRY_DELAY_MS = 5;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface SerializationRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  // Injected by the unit tests so retry behaviour can be asserted without
  // real timers and without depending on the Postgres scheduler.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Re-runs `operation` from scratch on a serialization failure, and only on a
// serialization failure. Business errors and unknown errors propagate on the
// first attempt: retrying those would either duplicate a side effect or hide
// a genuine bug.
//
// The caller must pass the WHOLE transaction as `operation`, never just its
// failing statement — every decision that depends on database state has to be
// recomputed against the state the winning transaction left behind, otherwise
// a retry could re-apply a decision (such as "no duplicate exists") that the
// conflict just invalidated.
export const runWithSerializationRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  options: SerializationRetryOptions = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? MAX_SERIALIZATION_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? BASE_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  if (maxAttempts < 1) {
    throw new RangeError("maxAttempts must be at least 1");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isSerializationFailure(error)) {
        throw error;
      }

      lastError = error;

      if (attempt < maxAttempts) {
        await sleep(Math.round(random() * baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }

  // Budget exhausted: the conflict is not clearing on its own, so it stays a
  // real error instead of being retried indefinitely or silently swallowed.
  throw lastError;
};
