import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  AgentApiKeyConfigError,
  generateAgentApiKey,
  hashAgentApiKeySecret,
  parseAgentApiKey,
  verifyAgentApiKeySecret,
} from "./agent-api-key.service";

describe("agent-api-key.service", () => {
  const originalPepper = process.env.AGENT_API_KEY_PEPPER;

  before(() => {
    process.env.AGENT_API_KEY_PEPPER = "test-pepper-not-a-real-secret";
  });

  after(() => {
    process.env.AGENT_API_KEY_PEPPER = originalPepper;
  });

  test("generateAgentApiKey produces a well-formed jja_<prefix>_<secret> key", () => {
    const generated = generateAgentApiKey();

    assert.equal(generated.fullKey, `jja_${generated.prefix}_${generated.secret}`);
    assert.match(generated.prefix, /^[0-9a-f]{16}$/);
    assert.ok(generated.secret.length >= 32);
    assert.equal(generated.secretHash, hashAgentApiKeySecret(generated.secret));
  });

  test("parseAgentApiKey accepts a valid key", () => {
    const generated = generateAgentApiKey();
    const parsed = parseAgentApiKey(generated.fullKey);

    assert.deepEqual(parsed, {
      prefix: generated.prefix,
      secret: generated.secret,
    });
  });

  test("parseAgentApiKey handles secrets containing underscores (base64url alphabet)", () => {
    const parsed = parseAgentApiKey(
      "jja_0123456789abcdef_abc_def_ghijklmnopqrstuvwxyz0123456789AB",
    );

    assert.ok(parsed);
    assert.equal(parsed!.prefix, "0123456789abcdef");
    assert.equal(parsed!.secret, "abc_def_ghijklmnopqrstuvwxyz0123456789AB");
  });

  test("parseAgentApiKey rejects malformed keys", () => {
    assert.equal(parseAgentApiKey(""), null);
    assert.equal(parseAgentApiKey("not-a-key"), null);
    assert.equal(parseAgentApiKey("jja_onlyprefix"), null);
    assert.equal(parseAgentApiKey("jja_short_secretaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), null);
    assert.equal(parseAgentApiKey("jja_0123456789abcdef_"), null);
    assert.equal(parseAgentApiKey(null as unknown as string), null);
  });

  test("verifyAgentApiKeySecret accepts the correct secret and rejects a wrong one", () => {
    const generated = generateAgentApiKey();

    assert.equal(
      verifyAgentApiKeySecret(generated.secret, generated.secretHash),
      true,
    );
    assert.equal(
      verifyAgentApiKeySecret("wrong-secret", generated.secretHash),
      false,
    );
  });

  test("hashing throws AgentApiKeyConfigError when the pepper is missing", () => {
    const saved = process.env.AGENT_API_KEY_PEPPER;
    delete process.env.AGENT_API_KEY_PEPPER;

    try {
      assert.throws(
        () => hashAgentApiKeySecret("some-secret"),
        AgentApiKeyConfigError,
      );
    } finally {
      process.env.AGENT_API_KEY_PEPPER = saved;
    }
  });
});
