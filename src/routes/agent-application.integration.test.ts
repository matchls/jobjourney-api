import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app";
import prisma from "../config/prisma";
import { generateAgentApiKey } from "../services/agent-api-key.service";

// Integration tests exercise the real Express app + the dev database
// configured via DATABASE_URL. Every row created here hangs off one
// dedicated test User, deleted in the `after` hook — its onDelete: Cascade
// relations (Application, AgentApiKey, AgentImportReceipt) take care of the
// rest, so cleanup is a single delete.
const TEST_RUN_ID = `agenttest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EMAIL = `${TEST_RUN_ID}@example.test`;
const AGENT_SCOPE = "applications:create";

let server: http.Server;
let baseUrl: string;
let userId: string;

const createApiKey = async (
  opts: { scopes?: string[]; revokedAt?: Date | null; expiresAt?: Date | null } = {},
) => {
  const generated = generateAgentApiKey();
  const apiKey = await prisma.agentApiKey.create({
    data: {
      userId,
      name: "integration test key",
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      scopes: opts.scopes ?? [AGENT_SCOPE],
      revokedAt: opts.revokedAt ?? null,
      expiresAt: opts.expiresAt ?? null,
    },
  });
  return { apiKey, fullKey: generated.fullKey };
};

const postApplication = (fullKey: string, body: unknown, idempotencyKey?: string) =>
  fetch(`${baseUrl}/agent/applications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${fullKey}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });

describe("POST /agent/applications", () => {
  before(async () => {
    process.env.AGENT_API_KEY_PEPPER = "integration-test-pepper-not-real";

    const user = await prisma.user.create({
      data: { email: TEST_EMAIL, passwordHash: null, name: "Agent Test User" },
    });
    userId = user.id;

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  test("rejects a missing Authorization header with 401", async () => {
    const res = await fetch(`${baseUrl}/agent/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "Acme", position: "Engineer" }),
    });
    assert.equal(res.status, 401);
  });

  test("rejects a malformed bearer key with 401", async () => {
    const res = await postApplication(
      "not-a-real-key",
      { company: "Acme", position: "Engineer" },
      "key-1",
    );
    assert.equal(res.status, 401);
  });

  test("rejects an unknown key with a generic 401 (never reveals prefix existence)", async () => {
    const { fullKey } = await createApiKey();
    const tampered = fullKey.slice(0, -1) + (fullKey.endsWith("A") ? "B" : "A");
    const res = await postApplication(tampered, { company: "Acme", position: "Engineer" }, "key-2");
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "unauthorized");
  });

  test("rejects a key with an insufficient scope with 403", async () => {
    const { fullKey } = await createApiKey({ scopes: ["applications:read"] });
    const res = await postApplication(fullKey, { company: "Acme", position: "Engineer" }, "key-3");
    assert.equal(res.status, 403);
  });

  test("rejects a revoked key with 403", async () => {
    const { fullKey } = await createApiKey({ revokedAt: new Date() });
    const res = await postApplication(fullKey, { company: "Acme", position: "Engineer" }, "key-4");
    assert.equal(res.status, 403);
  });

  test("rejects an expired key with 403", async () => {
    const { fullKey } = await createApiKey({ expiresAt: new Date(Date.now() - 1000) });
    const res = await postApplication(fullKey, { company: "Acme", position: "Engineer" }, "key-5");
    assert.equal(res.status, 403);
  });

  test("rejects a missing Idempotency-Key header with 400", async () => {
    const { fullKey } = await createApiKey();
    const res = await postApplication(fullKey, { company: "Acme", position: "Engineer" });
    assert.equal(res.status, 400);
  });

  test("rejects an invalid payload with structured 400 errors", async () => {
    const { fullKey } = await createApiKey();
    const res = await postApplication(fullKey, { company: "Acme" }, "key-6");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "validation_error");
    assert.ok(body.error.fieldErrors);
  });

  test("creates an application owned by the key's user", async () => {
    const { fullKey } = await createApiKey();
    const res = await postApplication(
      fullKey,
      { company: "Acme", position: "Engineer", stack: ["ts"] },
      "key-7",
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, "created");
    assert.equal(body.duplicate, false);
    assert.equal(body.idempotent, false);

    const application = await prisma.application.findUnique({ where: { id: body.applicationId } });
    assert.ok(application);
    assert.equal(application!.userId, userId);
    assert.equal(application!.creationSource, "AGENT_IMPORT");
    assert.equal(application!.importReviewStatus, "NOT_REQUIRED");
  });

  test("marks importReviewStatus as PENDING when uncertainFields are provided", async () => {
    const { fullKey } = await createApiKey();
    const res = await postApplication(
      fullKey,
      { company: "Uncertain Co", position: "Engineer", agentAnalysis: { uncertainFields: ["salary"] } },
      "key-8",
    );
    const body = await res.json();
    const application = await prisma.application.findUnique({ where: { id: body.applicationId } });
    assert.equal(application!.importReviewStatus, "PENDING");
    assert.deepEqual(application!.uncertainFields, ["salary"]);
  });

  test("same Idempotency-Key + same payload replays the same application (200, idempotent)", async () => {
    const { fullKey } = await createApiKey();
    const payload = { company: "Repeat Co", position: "Engineer" };

    const first = await postApplication(fullKey, payload, "key-9");
    const firstBody = await first.json();
    assert.equal(first.status, 201);

    const second = await postApplication(fullKey, payload, "key-9");
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.idempotent, true);
    assert.equal(secondBody.applicationId, firstBody.applicationId);

    const count = await prisma.application.count({ where: { company: "Repeat Co", userId } });
    assert.equal(count, 1);
  });

  test("same Idempotency-Key + different payload is rejected with 409", async () => {
    const { fullKey } = await createApiKey();
    const first = await postApplication(
      fullKey,
      { company: "Conflict Co", position: "Engineer" },
      "key-10",
    );
    assert.equal(first.status, 201);

    const second = await postApplication(
      fullKey,
      { company: "Conflict Co", position: "Manager" },
      "key-10",
    );
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.error.code, "idempotency_conflict");
  });

  test("a duplicate offerUrl (modulo tracking params) does not create a second application", async () => {
    const { fullKey } = await createApiKey();
    const first = await postApplication(
      fullKey,
      {
        company: "URL Co",
        position: "Engineer",
        offerUrl: "https://example.com/jobs/duplicate-test?utm_source=agent",
      },
      "key-11",
    );
    const firstBody = await first.json();
    assert.equal(first.status, 201);

    const second = await postApplication(
      fullKey,
      {
        company: "URL Co",
        position: "Engineer",
        offerUrl: "https://example.com/jobs/duplicate-test?gclid=abc",
      },
      "key-12",
    );
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.status, "duplicate");
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.applicationId, firstBody.applicationId);

    const count = await prisma.application.count({ where: { userId, company: "URL Co" } });
    assert.equal(count, 1);
  });

  test("a duplicate without offerUrl falls back to normalized company+position+location", async () => {
    const { fullKey } = await createApiKey();
    const first = await postApplication(
      fullKey,
      { company: "Fallback Co", position: "Engineer", location: "Lyon" },
      "key-13",
    );
    const firstBody = await first.json();
    assert.equal(first.status, 201);

    const second = await postApplication(
      fullKey,
      { company: "  fallback  co ", position: "ENGINEER", location: "lyon" },
      "key-14",
    );
    const secondBody = await second.json();
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.applicationId, firstBody.applicationId);
  });

  test("concurrent requests with the same Idempotency-Key create only one application", async () => {
    const { fullKey } = await createApiKey();
    const payload = { company: "Concurrent Idem Co", position: "Engineer" };

    const [a, b] = await Promise.all([
      postApplication(fullKey, payload, "key-15"),
      postApplication(fullKey, payload, "key-15"),
    ]);
    const [aBody, bBody] = await Promise.all([a.json(), b.json()]);
    assert.equal(aBody.applicationId, bBody.applicationId);

    const count = await prisma.application.count({
      where: { userId, company: "Concurrent Idem Co" },
    });
    assert.equal(count, 1);
  });

  test("concurrent requests with the same dedup fingerprint create only one application", async () => {
    const { fullKey } = await createApiKey();
    const offerUrl = "https://example.com/jobs/concurrent-fingerprint";

    const [a, b] = await Promise.all([
      postApplication(fullKey, { company: "Race Co", position: "Engineer", offerUrl }, "key-16"),
      postApplication(fullKey, { company: "Race Co", position: "Engineer", offerUrl }, "key-17"),
    ]);
    const [aBody, bBody] = await Promise.all([a.json(), b.json()]);
    assert.equal(aBody.applicationId, bBody.applicationId);

    const count = await prisma.application.count({ where: { userId, company: "Race Co" } });
    assert.equal(count, 1);
  });

  test("never logs the bearer secret, the full key, or the secret hash", async () => {
    const { fullKey, apiKey } = await createApiKey();
    const logged: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    try {
      await postApplication(fullKey, { company: "Log Co", position: "Engineer" }, "key-18");
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const secret = fullKey.split("_").slice(2).join("_");
    for (const line of logged) {
      assert.equal(line.includes(fullKey), false);
      assert.equal(line.includes(secret), false);
      assert.equal(line.includes(apiKey.secretHash), false);
    }
  });
});
