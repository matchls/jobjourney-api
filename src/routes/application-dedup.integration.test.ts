import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app";
import prisma from "../config/prisma";
import { generateAgentApiKey } from "../services/agent-api-key.service";

// Covers issue #21: POST /applications must refuse a duplicate with
// 409 application_duplicate, reusing the fingerprint already shared by
// POST /agent/applications and PATCH /applications/:id — and must leave
// both of those endpoints behaving exactly as before.
//
// Integration tests run against the real Express app + the database in
// DATABASE_URL. Every row hangs off one dedicated test User deleted in the
// `after` hook; its onDelete: Cascade relations clean up the rest.
//
// The duplicate lookup scans ALL of the user's applications, so each test
// uses company/position values unique to itself — otherwise a row left by an
// earlier test would make a later one fail for the wrong reason.
const TEST_RUN_ID = `deduptest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EMAIL = `${TEST_RUN_ID}@example.test`;
const OTHER_EMAIL = `other-${TEST_RUN_ID}@example.test`;
const TEST_PASSWORD = "correct-horse-battery-staple";
const AGENT_SCOPE = "applications:create";

let server: http.Server;
let baseUrl: string;
let userId: string;
let otherUserId: string;
let authCookie: string;
let otherAuthCookie: string;

const extractCookie = (res: Response): string => {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header");
  return setCookie!.split(";")[0];
};

const register = async (email: string) => {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  assert.equal(res.status, 201, `registration failed for ${email}`);
  const body = await res.json();
  return { id: body.id as string, cookie: extractCookie(res) };
};

const postApplication = (body: unknown, cookie = authCookie) =>
  fetch(`${baseUrl}/applications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

const patchApplication = (id: string, body: unknown) =>
  fetch(`${baseUrl}/applications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: authCookie },
    body: JSON.stringify(body),
  });

const postAgentApplication = (
  fullKey: string,
  body: unknown,
  idempotencyKey: string,
) =>
  fetch(`${baseUrl}/agent/applications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${fullKey}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

const createAgentApiKey = async (targetUserId: string) => {
  const generated = generateAgentApiKey();
  await prisma.agentApiKey.create({
    data: {
      userId: targetUserId,
      name: "dedup test key",
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      scopes: [AGENT_SCOPE],
    },
  });
  return generated.fullKey;
};

const assertDuplicateResponse = async (res: Response) => {
  assert.equal(res.status, 409, "a duplicate must be refused with 409");
  const body = await res.json();
  assert.equal(body.error.code, "application_duplicate");
};

const countApplications = (company: string) =>
  prisma.application.count({ where: { userId, company } });

describe("POST /applications — duplicate detection (#21)", () => {
  before(async () => {
    process.env.AGENT_API_KEY_PEPPER = "dedup-test-pepper-not-real";

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const owner = await register(TEST_EMAIL);
    userId = owner.id;
    authCookie = owner.cookie;

    const other = await register(OTHER_EMAIL);
    otherUserId = other.id;
    otherAuthCookie = other.cookie;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
    await prisma.$disconnect();
  });

  // --- Duplicate by offerUrl -------------------------------------------

  test("refuses a second application with the same offerUrl", async () => {
    const company = `UrlDup Co ${TEST_RUN_ID}`;
    const offerUrl = `https://example.com/jobs/url-dup-${TEST_RUN_ID}`;

    const first = await postApplication({
      company,
      position: "Developpeur React",
      offerUrl,
    });
    assert.equal(first.status, 201);

    const second = await postApplication({
      company,
      position: "Developpeur React",
      offerUrl,
    });
    await assertDuplicateResponse(second);

    assert.equal(await countApplications(company), 1, "nothing was persisted");
  });

  test("refuses the same offerUrl even when tracking params or a fragment differ", async () => {
    const company = `UrlNorm Co ${TEST_RUN_ID}`;
    const offerUrl = `https://example.com/jobs/url-norm-${TEST_RUN_ID}?ref=abc`;

    const first = await postApplication({
      company,
      position: "Data Engineer",
      offerUrl,
    });
    assert.equal(first.status, 201);

    // utm_*/gclid and the hash are stripped by normalizeUrlForFingerprint,
    // and the remaining query params are sorted — so this is the same offer.
    const second = await postApplication({
      company,
      position: "Data Engineer",
      offerUrl: `${offerUrl}&utm_source=newsletter&gclid=xyz#apply`,
    });
    await assertDuplicateResponse(second);

    assert.equal(await countApplications(company), 1);
  });

  test("refuses a duplicate offerUrl even when the free-text fields differ", async () => {
    const company = `UrlWins Co ${TEST_RUN_ID}`;
    const offerUrl = `https://example.com/jobs/url-wins-${TEST_RUN_ID}`;

    assert.equal(
      (await postApplication({ company, position: "Engineer", offerUrl })).status,
      201,
    );

    // Both sides have an offerUrl, so the URL alone decides: the differing
    // company/position text must not rescue this creation.
    const second = await postApplication({
      company: `Totally Different Co ${TEST_RUN_ID}`,
      position: "Chef de projet",
      offerUrl,
    });
    await assertDuplicateResponse(second);
  });

  // --- Duplicate by normalized company + position + location ------------

  test("refuses a duplicate on normalized company/position/location, without any URL", async () => {
    const company = `Fallback Co ${TEST_RUN_ID}`;

    const first = await postApplication({
      company,
      position: "Developpeur Back-End",
      location: "Paris",
    });
    assert.equal(first.status, 201);

    // Differs only by casing and extra whitespace — normalizeText trims,
    // collapses runs of whitespace and lowercases, so the key is identical.
    const second = await postApplication({
      company: `  ${company.toUpperCase()}   `,
      position: "developpeur   BACK-END",
      location: " paris ",
    });
    await assertDuplicateResponse(second);

    assert.equal(await countApplications(company), 1);
  });

  test("refuses a duplicate when neither side has a location", async () => {
    const company = `NoLocation Co ${TEST_RUN_ID}`;

    assert.equal(
      (await postApplication({ company, position: "QA Engineer" })).status,
      201,
    );
    await assertDuplicateResponse(
      await postApplication({ company, position: "qa engineer" }),
    );
  });

  test("refuses a duplicate when only one side carries an offerUrl", async () => {
    const company = `MixedShape Co ${TEST_RUN_ID}`;

    assert.equal(
      (await postApplication({ company, position: "Engineer", location: "Lyon" }))
        .status,
      201,
    );

    // The existing row has no URL, so no URL comparison is possible and the
    // rule falls back to company/position/location — which match.
    const second = await postApplication({
      company,
      position: "Engineer",
      location: "Lyon",
      offerUrl: `https://example.com/jobs/mixed-${TEST_RUN_ID}`,
    });
    await assertDuplicateResponse(second);
  });

  // --- Genuinely different applications stay creatable -------------------

  test("creates a genuinely different application", async () => {
    const first = await postApplication({
      company: `Different A ${TEST_RUN_ID}`,
      position: "Developpeur React",
      location: "Paris",
    });
    assert.equal(first.status, 201);

    const second = await postApplication({
      company: `Different B ${TEST_RUN_ID}`,
      position: "Developpeur Vue",
      location: "Nantes",
    });
    assert.equal(second.status, 201, "a different application is still creatable");
    const body = await second.json();
    assert.equal(body.company, `Different B ${TEST_RUN_ID}`);
    assert.equal(body.creationSource, "MANUAL");
    assert.equal(body.agentDedupKey, null, "manual creations never write the import-only column");
  });

  test("treats a different location as a different application", async () => {
    const company = `SameRole Co ${TEST_RUN_ID}`;

    assert.equal(
      (await postApplication({ company, position: "Engineer", location: "Paris" }))
        .status,
      201,
    );
    assert.equal(
      (await postApplication({ company, position: "Engineer", location: "Bordeaux" }))
        .status,
      201,
      "same company and role in another city is a real second application",
    );
  });

  test("treats two distinct offers from the same company as distinct", async () => {
    const company = `TwoOffers Co ${TEST_RUN_ID}`;

    assert.equal(
      (
        await postApplication({
          company,
          position: "Engineer",
          offerUrl: `https://example.com/jobs/two-offers-a-${TEST_RUN_ID}`,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await postApplication({
          company,
          position: "Engineer",
          offerUrl: `https://example.com/jobs/two-offers-b-${TEST_RUN_ID}`,
        })
      ).status,
      201,
      "two different postings must not collapse into one",
    );
  });

  test("scopes the check to the owner — another user can create the same application", async () => {
    const company = `CrossUser Co ${TEST_RUN_ID}`;
    const payload = { company, position: "Engineer", location: "Paris" };

    assert.equal((await postApplication(payload)).status, 201);
    assert.equal((await postApplication(payload)).status, 409);
    assert.equal(
      (await postApplication(payload, otherAuthCookie)).status,
      201,
      "another user's identical application is not a duplicate",
    );
  });

  test("still rejects an invalid payload with 400 before any duplicate check", async () => {
    const res = await postApplication({ company: "", position: "" });
    assert.equal(res.status, 400);
  });

  // --- Non-regression: POST /agent/applications --------------------------

  test("POST /agent/applications keeps its created/duplicate behaviour", async () => {
    const fullKey = await createAgentApiKey(userId);
    const company = `AgentRegress Co ${TEST_RUN_ID}`;
    const payload = { company, position: "Engineer", location: "Paris" };

    const created = await postAgentApplication(fullKey, payload, `agent-${TEST_RUN_ID}-1`);
    assert.equal(created.status, 201, "agent import still creates with 201");
    const createdBody = await created.json();
    assert.equal(createdBody.status, "created");
    assert.equal(createdBody.duplicate, false);

    // A second import of the same job still reports duplicate: true with 200
    // — it must NOT start returning the manual route's 409.
    const duplicate = await postAgentApplication(fullKey, payload, `agent-${TEST_RUN_ID}-2`);
    assert.equal(duplicate.status, 200, "agent duplicate is still 200, not 409");
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.status, "duplicate");
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.applicationId, createdBody.applicationId);

    // Replaying the exact first request stays idempotent.
    const replay = await postAgentApplication(fullKey, payload, `agent-${TEST_RUN_ID}-1`);
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.idempotent, true);
    assert.equal(replayBody.applicationId, createdBody.applicationId);
  });

  test("an agent-imported application is a duplicate for the manual route too", async () => {
    const fullKey = await createAgentApiKey(userId);
    const company = `AgentThenManual Co ${TEST_RUN_ID}`;
    const payload = { company, position: "Engineer", location: "Paris" };

    const imported = await postAgentApplication(fullKey, payload, `mixed-${TEST_RUN_ID}-1`);
    assert.equal(imported.status, 201);

    // Same rule regardless of how the existing row was created.
    await assertDuplicateResponse(await postApplication(payload));
  });

  // --- Non-regression: PATCH /applications/:id ---------------------------

  test("PATCH /applications/:id still edits a manual application normally", async () => {
    const created = await postApplication({
      company: `PatchOk Co ${TEST_RUN_ID}`,
      position: "Engineer",
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const patched = await patchApplication(id, { contractType: "CDI", notes: "ok" });
    assert.equal(patched.status, 200, "an ordinary edit is untouched");
    const patchedBody = await patched.json();
    assert.equal(patchedBody.contractType, "CDI");
  });

  test("PATCH /applications/:id keeps its existing duplicate behaviour on imports", async () => {
    const existing = await prisma.application.create({
      data: {
        company: `PatchTarget Co ${TEST_RUN_ID}`,
        position: "Engineer",
        userId,
        creationSource: "AGENT_IMPORT",
        importReviewStatus: "NOT_REQUIRED",
        agentDedupKey: `patch-target-${TEST_RUN_ID}`,
      },
    });

    const beingEdited = await prisma.application.create({
      data: {
        company: `PatchEdited Co ${TEST_RUN_ID}`,
        position: "Engineer",
        userId,
        creationSource: "AGENT_IMPORT",
        importReviewStatus: "NOT_REQUIRED",
        agentDedupKey: `patch-edited-${TEST_RUN_ID}`,
      },
    });

    const res = await patchApplication(beingEdited.id, {
      company: `PatchTarget Co ${TEST_RUN_ID}`,
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "application_duplicate");

    const unchanged = await prisma.application.findUnique({
      where: { id: beingEdited.id },
    });
    assert.equal(unchanged!.company, `PatchEdited Co ${TEST_RUN_ID}`);
    assert.equal(existing.id !== beingEdited.id, true);
  });

  test("PATCH on a MANUAL application is still not fingerprint-checked", async () => {
    const first = await postApplication({
      company: `ManualPatchA Co ${TEST_RUN_ID}`,
      position: "Engineer",
    });
    assert.equal(first.status, 201);

    const second = await postApplication({
      company: `ManualPatchB Co ${TEST_RUN_ID}`,
      position: "Engineer",
    });
    assert.equal(second.status, 201);
    const { id } = await second.json();

    // Documents today's behaviour rather than endorsing it: the PATCH dedup
    // branch only runs for creationSource === "AGENT_IMPORT", and #21 must
    // not change PATCH. Editing a MANUAL row into another one still passes.
    const res = await patchApplication(id, {
      company: `ManualPatchA Co ${TEST_RUN_ID}`,
    });
    assert.equal(res.status, 200, "PATCH behaviour on MANUAL rows is unchanged");
  });
});
