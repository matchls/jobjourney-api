import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app";
import prisma from "../config/prisma";

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

describe("PATCH /applications/:id — confirmImportReview", () => {
  before(async () => {
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
});
