import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeAgentDedupKey,
  computeRequestHash,
  normalizeText,
  normalizeUrlForFingerprint,
} from "./agent-dedup";

describe("agent-dedup", () => {
  test("normalizeText trims, collapses whitespace and lowercases", () => {
    assert.equal(normalizeText("  Acme   Corp  "), "acme corp");
    assert.equal(normalizeText("ACME"), normalizeText("acme"));
  });

  test("normalizeUrlForFingerprint strips fragment, tracking params and default port", () => {
    const normalized = normalizeUrlForFingerprint(
      "https://Example.com:443/jobs/42?utm_source=agent&gclid=abc&ref=keep#section",
    );

    assert.equal(normalized, "https://example.com/jobs/42?ref=keep");
  });

  test("normalizeUrlForFingerprint is stable regardless of tracking-param order", () => {
    const a = normalizeUrlForFingerprint(
      "https://example.com/jobs/42?fbclid=1&role=eng&utm_campaign=x",
    );
    const b = normalizeUrlForFingerprint(
      "https://example.com/jobs/42?utm_campaign=x&role=eng&fbclid=1",
    );

    assert.equal(a, b);
  });

  test("computeAgentDedupKey is stable for equivalent URLs and differs for different ones", () => {
    const a = computeAgentDedupKey({
      offerUrl: "https://example.com/jobs/42?utm_source=agent",
      company: "Acme",
      position: "Engineer",
    });
    const b = computeAgentDedupKey({
      offerUrl: "https://example.com/jobs/42",
      company: "Acme",
      position: "Engineer",
    });
    const c = computeAgentDedupKey({
      offerUrl: "https://example.com/jobs/99",
      company: "Acme",
      position: "Engineer",
    });

    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test("computeAgentDedupKey falls back to normalized company/position/location without a URL", () => {
    const a = computeAgentDedupKey({
      company: "  Acme  Corp ",
      position: "Backend Engineer",
      location: "Paris",
    });
    const b = computeAgentDedupKey({
      company: "acme corp",
      position: "backend engineer",
      location: "PARIS",
    });
    const c = computeAgentDedupKey({
      company: "Acme Corp",
      position: "Frontend Engineer",
      location: "Paris",
    });

    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test("computeRequestHash is stable regardless of key order and sensitive to content changes", () => {
    const a = computeRequestHash({ company: "Acme", position: "Engineer", stack: ["ts", "node"] });
    const b = computeRequestHash({ stack: ["ts", "node"], position: "Engineer", company: "Acme" });
    const c = computeRequestHash({ company: "Acme", position: "Manager", stack: ["ts", "node"] });

    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
