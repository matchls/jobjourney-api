import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  MAX_SERIALIZATION_ATTEMPTS,
  isSerializationFailure,
  runWithSerializationRetry,
} from "./serializable-retry";

// The real thing Postgres raises for SQLSTATE 40001, as Prisma hands it to
// the application. Built explicitly so these tests prove the retry contract
// without depending on the Postgres scheduler actually producing a race.
const serializationFailure = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
    { code: "P2034", clientVersion: "5.22.0" },
  );

const uniqueConstraintFailure = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
  });

// Injected everywhere below: no real timers, so the suite stays fast and
// fully deterministic.
const collectSleeps = () => {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
};

describe("serializable-retry", () => {
  describe("isSerializationFailure", () => {
    test("recognises the Prisma code Postgres 40001 maps to", () => {
      assert.equal(isSerializationFailure(serializationFailure()), true);
    });

    test("does not treat other Prisma errors as serialization failures", () => {
      assert.equal(isSerializationFailure(uniqueConstraintFailure()), false);
    });

    test("does not treat plain errors or non-errors as serialization failures", () => {
      assert.equal(isSerializationFailure(new Error("P2034")), false);
      assert.equal(isSerializationFailure({ code: "P2034" }), false);
      assert.equal(isSerializationFailure(undefined), false);
    });
  });

  test("returns the result without retrying when the operation succeeds", async () => {
    let calls = 0;
    const { slept, sleep } = collectSleeps();

    const result = await runWithSerializationRetry(async () => {
      calls += 1;
      return "ok";
    }, { sleep });

    assert.equal(result, "ok");
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });

  test("retries a serialization failure and returns the later attempt's result", async () => {
    let calls = 0;
    const { slept, sleep } = collectSleeps();

    const result = await runWithSerializationRetry(async (attempt) => {
      calls += 1;
      if (attempt === 1) {
        throw serializationFailure();
      }
      return `ok on attempt ${attempt}`;
    }, { sleep });

    assert.equal(result, "ok on attempt 2");
    assert.equal(calls, 2);
    assert.equal(slept.length, 1, "waits once, between the two attempts");
  });

  test("keeps retrying while attempts remain, then succeeds", async () => {
    let calls = 0;
    const { sleep } = collectSleeps();

    const result = await runWithSerializationRetry(async (attempt) => {
      calls += 1;
      if (attempt < MAX_SERIALIZATION_ATTEMPTS) {
        throw serializationFailure();
      }
      return "recovered";
    }, { sleep });

    assert.equal(result, "recovered");
    assert.equal(calls, MAX_SERIALIZATION_ATTEMPTS);
  });

  test("re-runs the whole operation, so state-dependent decisions are recomputed", async () => {
    // Mirrors the import flow: attempt 1 sees no duplicate and conflicts;
    // by attempt 2 the winning transaction has committed, and the operation
    // must observe that new state rather than replay its first decision.
    const committed: string[] = [];
    const { sleep } = collectSleeps();
    let attempts = 0;

    const outcome = await runWithSerializationRetry(async () => {
      attempts += 1;
      const existing = committed.length > 0;
      if (attempts === 1) {
        committed.push("winner");
        throw serializationFailure();
      }
      return existing ? "duplicate" : "created";
    }, { sleep });

    assert.equal(attempts, 2);
    assert.equal(outcome, "duplicate");
  });

  test("does NOT retry a unique-constraint error", async () => {
    let calls = 0;
    const { slept, sleep } = collectSleeps();

    await assert.rejects(
      runWithSerializationRetry(async () => {
        calls += 1;
        throw uniqueConstraintFailure();
      }, { sleep }),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002",
    );

    assert.equal(calls, 1, "a business error must not be replayed");
    assert.deepEqual(slept, []);
  });

  test("does NOT retry an unknown error", async () => {
    let calls = 0;
    const { sleep } = collectSleeps();

    await assert.rejects(
      runWithSerializationRetry(async () => {
        calls += 1;
        throw new Error("boom");
      }, { sleep }),
      /boom/,
    );

    assert.equal(calls, 1);
  });

  test("stops at the maximum number of attempts and rethrows the last failure", async () => {
    let calls = 0;
    const { slept, sleep } = collectSleeps();

    await assert.rejects(
      runWithSerializationRetry(async () => {
        calls += 1;
        throw serializationFailure();
      }, { sleep }),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034",
    );

    assert.equal(calls, MAX_SERIALIZATION_ATTEMPTS, "bounded, never infinite");
    assert.equal(
      slept.length,
      MAX_SERIALIZATION_ATTEMPTS - 1,
      "no wait after the final attempt",
    );
  });

  test("honours an explicit attempt budget", async () => {
    let calls = 0;
    const { sleep } = collectSleeps();

    await assert.rejects(
      runWithSerializationRetry(
        async () => {
          calls += 1;
          throw serializationFailure();
        },
        { maxAttempts: 2, sleep },
      ),
    );

    assert.equal(calls, 2);
  });

  test("a single-attempt budget disables retrying entirely", async () => {
    let calls = 0;
    const { slept, sleep } = collectSleeps();

    await assert.rejects(
      runWithSerializationRetry(
        async () => {
          calls += 1;
          throw serializationFailure();
        },
        { maxAttempts: 1, sleep },
      ),
    );

    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });

  test("rejects a nonsensical attempt budget instead of silently never running", async () => {
    await assert.rejects(
      runWithSerializationRetry(async () => "never", { maxAttempts: 0 }),
      RangeError,
    );
  });

  test("backs off exponentially and stays within the jitter window", async () => {
    const { slept, sleep } = collectSleeps();

    // random() pinned to its maximum: asserts the upper bound of each window.
    await assert.rejects(
      runWithSerializationRetry(
        async () => {
          throw serializationFailure();
        },
        { sleep, random: () => 1, baseDelayMs: 5 },
      ),
    );

    assert.deepEqual(slept, [5, 10, 20, 40]);
  });

  test("jitter can shorten any wait, so retries do not re-collide in lockstep", async () => {
    const { slept, sleep } = collectSleeps();

    await assert.rejects(
      runWithSerializationRetry(
        async () => {
          throw serializationFailure();
        },
        { sleep, random: () => 0, baseDelayMs: 5 },
      ),
    );

    assert.deepEqual(slept, [0, 0, 0, 0]);
  });
});
