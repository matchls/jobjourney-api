import crypto from "crypto";

const KEY_SCHEME = "jja";
const PREFIX_BYTES = 8; // 16 hex chars, unique + safe to use as a DB lookup key
const SECRET_BYTES = 32; // >= 32 random bytes per the security requirements

export class AgentApiKeyConfigError extends Error {
  constructor() {
    super("AGENT_API_KEY_PEPPER_MISSING");
  }
}

// Read lazily (not at module load) so a missing pepper never prevents the
// server from starting — only requests that actually need it fail, with a
// dedicated config-error type the caller maps to 503.
const getPepper = (): string => {
  const pepper = process.env.AGENT_API_KEY_PEPPER;

  if (!pepper) {
    throw new AgentApiKeyConfigError();
  }

  return pepper;
};

export interface GeneratedAgentApiKey {
  prefix: string;
  secret: string;
  fullKey: string;
  secretHash: string;
}

export const generateAgentApiKey = (): GeneratedAgentApiKey => {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString("hex");
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const fullKey = `${KEY_SCHEME}_${prefix}_${secret}`;

  return { prefix, secret, fullKey, secretHash: hashAgentApiKeySecret(secret) };
};

export const hashAgentApiKeySecret = (secret: string): string => {
  const pepper = getPepper();
  return crypto.createHmac("sha256", pepper).update(secret).digest("hex");
};

export const verifyAgentApiKeySecret = (
  secret: string,
  expectedHash: string,
): boolean => {
  const computedHash = hashAgentApiKeySecret(secret);
  const computed = Buffer.from(computedHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");

  if (computed.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(computed, expected);
};

export interface ParsedAgentApiKey {
  prefix: string;
  secret: string;
}

const PREFIX_PATTERN = /^[0-9a-f]{16}$/;

// Split on the *first* underscore only after the scheme: `secret` is
// base64url, whose alphabet includes "_", so a naive `split("_")` could
// truncate a legitimate secret.
export const parseAgentApiKey = (rawKey: string): ParsedAgentApiKey | null => {
  if (typeof rawKey !== "string") {
    return null;
  }

  const scheme = `${KEY_SCHEME}_`;

  if (!rawKey.startsWith(scheme)) {
    return null;
  }

  const rest = rawKey.slice(scheme.length);
  const separatorIndex = rest.indexOf("_");

  if (separatorIndex <= 0) {
    return null;
  }

  const prefix = rest.slice(0, separatorIndex);
  const secret = rest.slice(separatorIndex + 1);

  if (!PREFIX_PATTERN.test(prefix) || secret.length < 32) {
    return null;
  }

  return { prefix, secret };
};
