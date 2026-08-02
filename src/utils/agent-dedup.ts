import crypto from "crypto";

// Case-insensitive, whitespace-insensitive, Unicode-normalized comparison key
// for free-text fields (company/position/location) used by the URL-less
// dedup fallback.
export const normalizeText = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set(["gclid", "fbclid"]);

const isTrackingParam = (key: string): boolean => {
  const lowerKey = key.toLowerCase();
  return (
    TRACKING_PARAM_NAMES.has(lowerKey) ||
    TRACKING_PARAM_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))
  );
};

// Fingerprint-only normalization — the original offerUrl is always preserved
// as-is on the Application record; this value is never persisted or returned.
export const normalizeUrlForFingerprint = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    url.hash = "";

    const keptParams = Array.from(url.searchParams.entries())
      .filter(([key]) => !isTrackingParam(key))
      .sort(([a], [b]) => a.localeCompare(b));

    url.search = "";
    for (const [key, value] of keptParams) {
      url.searchParams.append(key, value);
    }

    // Hostname casing and default ports (http:80, https:443) are already
    // normalized by the WHATWG URL parser itself.
    return url.toString();
  } catch {
    // Should not happen (offerUrl is validated as a URL before this runs),
    // but never let a fingerprint computation throw the whole request away.
    return normalizeText(rawUrl);
  }
};

export interface AgentDedupInput {
  offerUrl?: string;
  company: string;
  position: string;
  location?: string;
}

const hashBasis = (basis: string): string =>
  crypto.createHash("sha256").update(basis).digest("hex");

const computeFallbackKey = (input: AgentDedupInput): string =>
  hashBasis(
    [
      "fallback",
      normalizeText(input.company),
      normalizeText(input.position),
      normalizeText(input.location ?? ""),
    ].join("|"),
  );

const computeUrlKey = (offerUrl: string): string =>
  hashBasis(`url:${normalizeUrlForFingerprint(offerUrl)}`);

export interface AgentDedupSignals {
  urlKey?: string;
  fallbackKey: string;
}

// Two independent signals rather than one: a URL-based fingerprint (only
// when an offerUrl is available) and a company/position/location fallback
// fingerprint, computed *unconditionally* — even when an offerUrl is also
// present. Comparing both (see applicationMatchesDedupSignals) is what makes
// the dedup rule "mixed": a candidate imported WITH an offerUrl can still be
// recognized as the same job as an existing application that has none (or
// vice versa), as long as company/position/location line up, instead of the
// two fingerprints silently living in disjoint hash spaces.
export const computeAgentDedupSignals = (
  input: AgentDedupInput,
): AgentDedupSignals => ({
  urlKey: input.offerUrl ? computeUrlKey(input.offerUrl) : undefined,
  fallbackKey: computeFallbackKey(input),
});

// Single composite value used where exactly one fingerprint is needed: the
// AgentApiKey-protected @@unique([userId, agentDedupKey]) column written at
// creation time, and the exact-match lookups used to resolve a concurrent
// insert race. Prefers the URL signal (more specific) when available.
// Uniqueness is enforced at the DB level by that constraint, so this
// fingerprint intentionally does NOT embed the userId itself.
export const computeAgentDedupKey = (input: AgentDedupInput): string => {
  const signals = computeAgentDedupSignals(input);
  return signals.urlKey ?? signals.fallbackKey;
};

// Deterministic across key order / nested key order so retries that
// re-serialize the same logical payload still hash identically.
//
// The accumulator is deliberately Object.create(null) rather than a `{}`
// literal: a plain object literal inherits the Object.prototype.__proto__
// accessor, so `acc["__proto__"] = val` wouldn't create an own property at
// all — it would silently reassign acc's own prototype (or be a no-op if
// `val` isn't an object/null), dropping that key from the hash entirely and
// making a payload that differs only in its "__proto__" value hash
// identically to one without it. A null-prototype object has no such
// accessor, so a key literally named "__proto__" (or "constructor" /
// "prototype", included defensively even though those aren't accessors on
// a plain object) always becomes a genuine own data property instead.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const acc: Record<string, unknown> = Object.create(null);
    for (const [key, val] of entries) {
      acc[key] = canonicalize(val);
    }
    return acc;
  }

  return value;
};

export const computeRequestHash = (payload: unknown): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");

export interface ApplicationFingerprintSource {
  offerUrl?: string | null;
  company: string;
  position: string;
  location?: string | null;
}

// Pure comparison, deliberately independent of any stored agentDedupKey
// column: it recomputes the fingerprint live from an application's current
// offerUrl/company/position/location, so it matches MANUAL applications
// (whose agentDedupKey is always null), applications created before this
// feature existed, and applications whose fields were corrected afterwards —
// not just applications that already went through the agent-import path.
//
// Exact mixed URL/fallback rule:
//   - both sides have an offerUrl  → compare normalized URLs ONLY. Two
//     different real postings that happen to share company/position/location
//     text must NOT be merged just because the text matches — the URL is the
//     more specific, authoritative signal once both sides have one.
//   - either side has no offerUrl  → compare the normalized
//     company/position/location fallback instead, since a URL-based
//     comparison isn't possible for the side that lacks one.
export const applicationMatchesDedupSignals = (
  application: ApplicationFingerprintSource,
  candidateSignals: AgentDedupSignals,
): boolean => {
  const applicationSignals = computeAgentDedupSignals({
    offerUrl: application.offerUrl ?? undefined,
    company: application.company,
    position: application.position,
    location: application.location ?? undefined,
  });

  if (candidateSignals.urlKey && applicationSignals.urlKey) {
    return candidateSignals.urlKey === applicationSignals.urlKey;
  }

  return candidateSignals.fallbackKey === applicationSignals.fallbackKey;
};
