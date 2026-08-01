import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app";
import prisma from "../config/prisma";
import { computeAgentDedupKey } from "../utils/agent-dedup";
import { generateAgentApiKey } from "../services/agent-api-key.service";

const AGENT_SCOPE = "applications:create";

const createAgentApiKey = async (targetUserId: string) => {
  const generated = generateAgentApiKey();
  await prisma.agentApiKey.create({
    data: {
      userId: targetUserId,
      name: "review test key",
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      scopes: [AGENT_SCOPE],
    },
  });
  return generated.fullKey;
};

// Covers: (1) confirmImportReview on the existing PATCH /applications/:id
// endpoint (web#14), and (2) a sanity check that classic email auth still
// works unmodified after wiring the /agent routes into app.ts.
const TEST_RUN_ID = `reviewtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EMAIL = `${TEST_RUN_ID}@example.test`;
const TEST_PASSWORD = "correct-horse-battery-staple";

let server: http.Server;
let baseUrl: string;
let userId: string;
let authCookie: string;

const extractCookie = (res: Response): string => {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header");
  return setCookie!.split(";")[0];
};

const postAgentApplication = (fullKey: string, body: unknown, idempotencyKey: string) =>
  fetch(`${baseUrl}/agent/applications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${fullKey}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

describe("PATCH /applications/:id — confirmImportReview", () => {
  before(async () => {
    process.env.AGENT_API_KEY_PEPPER = "review-test-pepper-not-real";

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const registerRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    assert.equal(registerRes.status, 201, "classic email registration still works");
    authCookie = extractCookie(registerRes);
    const registered = await registerRes.json();
    userId = registered.id;

    const meRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: authCookie },
    });
    assert.equal(meRes.status, 200, "GET /auth/me still works after registration");

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    assert.equal(loginRes.status, 200, "classic email login still works");
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  test("confirmImportReview marks an agent-imported application as REVIEWED", async () => {
    const imported = await prisma.application.create({
      data: {
        company: "Imported Co",
        position: "Engineer",
        userId,
        creationSource: "AGENT_IMPORT",
        importReviewStatus: "PENDING",
        uncertainFields: ["salary"],
        agentDedupKey: `test-${TEST_RUN_ID}-1`,
      },
    });

    const res = await fetch(`${baseUrl}/applications/${imported.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ confirmImportReview: true }),
    });
    assert.equal(res.status, 200);

    const updated = await prisma.application.findUnique({ where: { id: imported.id } });
    assert.equal(updated!.importReviewStatus, "REVIEWED");
    assert.ok(updated!.reviewedAt);
  });

  test("confirmImportReview never reaches Prisma as a raw column and cannot forge import metadata", async () => {
    const manual = await prisma.application.create({
      data: { company: "Manual Co", position: "Engineer", userId },
    });

    const res = await fetch(`${baseUrl}/applications/${manual.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({
        confirmImportReview: true,
        creationSource: "AGENT_IMPORT",
        agentImportMetadata: { forged: true },
        importedByApiKeyId: "not-a-real-key-id",
        agentDedupKey: "forged-dedup-key",
      }),
    });
    assert.equal(res.status, 200);

    const updated = await prisma.application.findUnique({ where: { id: manual.id } });
    // Not an import, so confirmImportReview is a no-op on review fields...
    assert.equal(updated!.importReviewStatus, "NOT_REQUIRED");
    assert.equal(updated!.reviewedAt, null);
    // ...and none of the import-only columns were forgeable through the body.
    assert.equal(updated!.creationSource, "MANUAL");
    assert.equal(updated!.agentImportMetadata, null);
    assert.equal(updated!.importedByApiKeyId, null);
    assert.equal(updated!.agentDedupKey, null);
  });

  test("returns 404 for an application that does not exist", async () => {
    const res = await fetch(`${baseUrl}/applications/does-not-exist`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ contractType: "CDI" }),
    });
    assert.equal(res.status, 404);
  });

  test("corrects contractType and confirms review in the same PATCH request", async () => {
    const imported = await prisma.application.create({
      data: {
        company: "Contract Co",
        position: "Engineer",
        userId,
        creationSource: "AGENT_IMPORT",
        importReviewStatus: "PENDING",
        uncertainFields: ["contractType"],
        agentDedupKey: computeAgentDedupKey({ company: "Contract Co", position: "Engineer" }),
      },
    });

    const res = await fetch(`${baseUrl}/applications/${imported.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ contractType: "CDI", confirmImportReview: true }),
    });
    assert.equal(res.status, 200);

    const updated = await prisma.application.findUnique({ where: { id: imported.id } });
    assert.equal(updated!.contractType, "CDI");
    assert.equal(updated!.importReviewStatus, "REVIEWED");
    assert.ok(updated!.reviewedAt);
  });

  test("correcting an offerUrl updates the fingerprint so a later agent import of it is detected as a duplicate", async () => {
    const imported = await prisma.application.create({
      data: {
        company: "URL Fix Co",
        position: "Engineer",
        userId,
        creationSource: "AGENT_IMPORT",
        importReviewStatus: "NOT_REQUIRED",
        agentDedupKey: computeAgentDedupKey({ company: "URL Fix Co", position: "Engineer" }),
      },
    });

    const correctedUrl = `https://example.com/jobs/url-fix-co-${TEST_RUN_ID}`;
    const patchRes = await fetch(`${baseUrl}/applications/${imported.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ offerUrl: correctedUrl }),
    });
    assert.equal(patchRes.status, 200);

    const afterPatch = await prisma.application.findUnique({ where: { id: imported.id } });
    assert.equal(
      afterPatch!.agentDedupKey,
      computeAgentDedupKey({ offerUrl: correctedUrl, company: "URL Fix Co", position: "Engineer" }),
    );

    const fullKey = await createAgentApiKey(userId);
    const importRes = await postAgentApplication(
      fullKey,
      { company: "URL Fix Co", position: "Engineer", offerUrl: correctedUrl },
      "url-fix-import-1",
    );
    assert.equal(importRes.status, 200);
    const importBody = await importRes.json();
    assert.equal(importBody.status, "duplicate");
    assert.equal(importBody.applicationId, imported.id);
  });

  test("correcting to a fingerprint that matches another application returns 409 and changes nothing", async () => {
    const existing = await prisma.application.create({
      data: {
        company: "Existing Target Co",
        position: "Engineer",
        userId,
        creationSource: "AGENT_IMPORT",
        importReviewStatus: "NOT_REQUIRED",
        agentDedupKey: computeAgentDedupKey({ company: "Existing Target Co", position: "Engineer" }),
      },
    });

    const beingEdited = await prisma.application.create({
      data: {
        company: "Being Edited Co",
        position: "Engineer",
        userId,
        creationSource: "AGENT_IMPORT",
        importReviewStatus: "NOT_REQUIRED",
        agentDedupKey: computeAgentDedupKey({ company: "Being Edited Co", position: "Engineer" }),
      },
    });

    const res = await fetch(`${baseUrl}/applications/${beingEdited.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ company: "Existing Target Co" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "application_duplicate");

    const unchanged = await prisma.application.findUnique({ where: { id: beingEdited.id } });
    assert.equal(unchanged!.company, "Being Edited Co");
    assert.notEqual(unchanged!.agentDedupKey, existing.agentDedupKey);
  });
});
