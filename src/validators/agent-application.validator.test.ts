import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentApplicationSchema,
  idempotencyKeySchema,
} from "./agent-application.validator";

describe("createAgentApplicationSchema", () => {
  test("accepts a minimal valid payload", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Backend Engineer",
    });

    assert.ok(result.success);
  });

  test("accepts a full payload including agentAnalysis", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Backend Engineer",
      offerUrl: "https://example.com/jobs/42",
      location: "Paris",
      contractType: "CDI",
      salary: "55k",
      jobDescription: "Build things.",
      notes: "Found via referral.",
      source: "LinkedIn",
      stack: ["Node.js", "TypeScript"],
      agentAnalysis: {
        summary: "Strong match on backend skills.",
        score: 82,
        confidenceByField: { salary: 0.4, location: 0.9 },
        uncertainFields: ["salary"],
      },
    });

    assert.ok(result.success);
  });

  test("rejects a payload missing required fields", () => {
    const result = createAgentApplicationSchema.safeParse({ company: "Acme" });
    assert.equal(result.success, false);
  });

  test("rejects unknown top-level properties (.strict())", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Engineer",
      sqlQuery: "DROP TABLE users;",
    });

    assert.equal(result.success, false);
  });

  test("rejects an invalid offerUrl", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Engineer",
      offerUrl: "not-a-url",
    });

    assert.equal(result.success, false);
  });

  test("treats empty-string optional fields as absent", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Engineer",
      location: "",
      offerUrl: "",
    });

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.location, undefined);
      assert.equal(result.data.offerUrl, undefined);
    }
  });

  test("rejects an agentAnalysis.score out of the 0-100 range", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Engineer",
      agentAnalysis: { score: 150 },
    });

    assert.equal(result.success, false);
  });

  test("rejects an agentAnalysis.confidenceByField value out of the 0-1 range", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Engineer",
      agentAnalysis: { confidenceByField: { salary: 1.5 } },
    });

    assert.equal(result.success, false);
  });

  test("rejects a stack array over the item limit", () => {
    const result = createAgentApplicationSchema.safeParse({
      company: "Acme",
      position: "Engineer",
      stack: Array.from({ length: 51 }, (_, i) => `skill-${i}`),
    });

    assert.equal(result.success, false);
  });
});

describe("idempotencyKeySchema", () => {
  test("accepts a normal key", () => {
    assert.ok(idempotencyKeySchema.safeParse("import-2026-08-01-001").success);
  });

  test("rejects an empty key", () => {
    assert.equal(idempotencyKeySchema.safeParse("").success, false);
  });

  test("rejects a key over 128 characters", () => {
    assert.equal(idempotencyKeySchema.safeParse("a".repeat(129)).success, false);
  });
});
