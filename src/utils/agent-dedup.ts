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

// Uniqueness is enforced at the DB level by @@unique([userId, agentDedupKey]),
// so this fingerprint intentionally does NOT embed the userId itself.
export const computeAgentDedupKey = (input: AgentDedupInput): string => {
  const basis = input.offerUrl
    ? `url:${normalizeUrlForFingerprint(input.offerUrl)}`
    : [
        "fallback",
        normalizeText(input.company),
        normalizeText(input.position),
        normalizeText(input.location ?? ""),
      ].join("|");

  return crypto.createHash("sha256").update(basis).digest("hex");
};

// Deterministic across key order / nested key order so retries that
// re-serialize the same logical payload still hash identically.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return entries.reduce<Record<string, unknown>>((acc, [key, val]) => {
      acc[key] = canonicalize(val);
      return acc;
    }, {});
  }

  return value;
};

export const computeRequestHash = (payload: unknown): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
