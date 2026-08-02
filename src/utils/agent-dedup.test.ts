import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applicationMatchesDedupSignals,
  computeAgentDedupKey,
  computeAgentDedupSignals,
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

describe("mixed URL/fallback dedup matching", () => {
  test("computeAgentDedupSignals returns both signals with an offerUrl, only the fallback without one", () => {
    const withUrl = computeAgentDedupSignals({
      offerUrl: "https://example.com/jobs/1",
      company: "Acme",
      position: "Engineer",
    });
    const withoutUrl = computeAgentDedupSignals({ company: "Acme", position: "Engineer" });

    assert.ok(withUrl.urlKey);
    assert.ok(withUrl.fallbackKey);
    assert.equal(withoutUrl.urlKey, undefined);
    assert.ok(withoutUrl.fallbackKey);
  });

  test("matches a URL-less application against a candidate that has a URL, via the fallback signal", () => {
    const application = {
      offerUrl: null,
      company: "Acme",
      position: "Engineer",
      location: "Paris",
    };
    const candidateSignals = computeAgentDedupSignals({
      offerUrl: "https://example.com/jobs/1",
      company: "Acme",
      position: "Engineer",
      location: "Paris",
    });

    assert.equal(applicationMatchesDedupSignals(application, candidateSignals), true);
  });

  test("matches an application that has a URL against a URL-less candidate, via the fallback signal", () => {
    const application = {
      offerUrl: "https://example.com/jobs/1",
      company: "Acme",
      position: "Engineer",
      location: "Paris",
    };
    const candidateSignals = computeAgentDedupSignals({
      company: "Acme",
      position: "Engineer",
      location: "Paris",
    });

    assert.equal(applicationMatchesDedupSignals(application, candidateSignals), true);
  });

  test("matches on the URL signal alone even when company/position text differs", () => {
    const application = {
      offerUrl: "https://example.com/jobs/42",
      company: "Acme Corp (via LinkedIn)",
      position: "Senior Backend Engineer",
      location: null,
    };
    const candidateSignals = computeAgentDedupSignals({
      offerUrl: "https://example.com/jobs/42?utm_source=agent",
      company: "Acme",
      position: "Engineer",
    });

    assert.equal(applicationMatchesDedupSignals(application, candidateSignals), true);
  });

  test("does not match unrelated applications", () => {
    const application = {
      offerUrl: "https://example.com/jobs/1",
      company: "Acme",
      position: "Engineer",
      location: "Paris",
    };
    const candidateSignals = computeAgentDedupSignals({
      offerUrl: "https://other.com/jobs/2",
      company: "Globex",
      position: "Designer",
      location: "Lyon",
    });

    assert.equal(applicationMatchesDedupSignals(application, candidateSignals), false);
  });

  test("does NOT match when both sides have different URLs, even with identical company/position/location text", () => {
    const application = {
      offerUrl: "https://example.com/jobs/posting-a",
      company: "Acme",
      position: "Engineer",
      location: "Paris",
    };
    const candidateSignals = computeAgentDedupSignals({
      offerUrl: "https://example.com/jobs/posting-b",
      company: "Acme",
      position: "Engineer",
      location: "Paris",
    });

    assert.equal(applicationMatchesDedupSignals(application, candidateSignals), false);
  });
});

describe("computeRequestHash canonicalization safety", () => {
  test("handles a __proto__ key without throwing and without corrupting Object.prototype", () => {
    const malicious = JSON.parse(
      '{"company":"Acme","position":"Engineer","__proto__":{"polluted":true}}',
    );

    assert.doesNotThrow(() => computeRequestHash(malicious));
    computeRequestHash(malicious);

    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test("a __proto__ key is hashed as real data, not silently dropped", () => {
    const withKeyA = JSON.parse('{"company":"Acme","__proto__":{"a":1}}');
    const withKeyB = JSON.parse('{"company":"Acme","__proto__":{"a":2}}');
    const withoutKey = { company: "Acme" };

    const hashA = computeRequestHash(withKeyA);
    const hashB = computeRequestHash(withKeyB);
    const hashWithoutKey = computeRequestHash(withoutKey);

    assert.notEqual(hashA, hashB);
    assert.notEqual(hashA, hashWithoutKey);
  });

  test("handles constructor and prototype keys as ordinary data", () => {
    const payload = JSON.parse(
      '{"company":"Acme","constructor":"weird","prototype":{"x":1}}',
    );

    assert.doesNotThrow(() => computeRequestHash(payload));
    const hash1 = computeRequestHash(payload);
    const hash2 = computeRequestHash({ ...payload, constructor: "different" });

    assert.notEqual(hash1, hash2);
  });
});
