import { Request, Response, NextFunction } from "express";
import prisma from "../config/prisma";
import {
  AgentApiKeyConfigError,
  parseAgentApiKey,
  verifyAgentApiKeySecret,
} from "../services/agent-api-key.service";
import { logAgentEvent } from "../utils/agent-logger";

export interface AgentAuthRequest extends Request {
  agentApiKeyId?: string;
  agentApiKeyPrefix?: string;
  userId?: string;
  scopes?: string[];
}

// Same body for every "the caller isn't allowed in" case regardless of the
// underlying reason (missing header, malformed key, unknown prefix, wrong
// secret) — the exact reason must never leak whether a given prefix exists.
const sendUnauthorized = (res: Response) => {
  res.status(401).json({ error: { code: "unauthorized" } });
};

const sendForbidden = (res: Response, code: string) => {
  res.status(403).json({ error: { code } });
};

export const requireAgentAuth = (requiredScope: string) => {
  return async (req: AgentAuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      sendUnauthorized(res);
      return;
    }

    const rawKey = authHeader.slice("Bearer ".length).trim();
    const parsed = parseAgentApiKey(rawKey);

    if (!parsed) {
      logAgentEvent({
        event: "agent_auth",
        result: "rejected",
        errorCode: "malformed_key",
      });
      sendUnauthorized(res);
      return;
    }

    const apiKey = await prisma.agentApiKey.findUnique({
      where: { prefix: parsed.prefix },
    });

    if (!apiKey) {
      logAgentEvent({
        event: "agent_auth",
        result: "rejected",
        apiKeyPrefix: parsed.prefix,
        errorCode: "unknown_key",
      });
      sendUnauthorized(res);
      return;
    }

    let secretValid: boolean;

    try {
      secretValid = verifyAgentApiKeySecret(parsed.secret, apiKey.secretHash);
    } catch (error) {
      if (error instanceof AgentApiKeyConfigError) {
        res.status(503).json({ error: { code: "agent_config_error" } });
        return;
      }
      throw error;
    }

    if (!secretValid) {
      logAgentEvent({
        event: "agent_auth",
        result: "rejected",
        apiKeyPrefix: apiKey.prefix,
        errorCode: "invalid_secret",
      });
      sendUnauthorized(res);
      return;
    }

    if (apiKey.revokedAt) {
      logAgentEvent({
        event: "agent_auth",
        result: "rejected",
        apiKeyPrefix: apiKey.prefix,
        userId: apiKey.userId,
        errorCode: "revoked_key",
      });
      sendForbidden(res, "revoked_key");
      return;
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      logAgentEvent({
        event: "agent_auth",
        result: "rejected",
        apiKeyPrefix: apiKey.prefix,
        userId: apiKey.userId,
        errorCode: "expired_key",
      });
      sendForbidden(res, "expired_key");
      return;
    }

    if (!apiKey.scopes.includes(requiredScope)) {
      logAgentEvent({
        event: "agent_auth",
        result: "rejected",
        apiKeyPrefix: apiKey.prefix,
        userId: apiKey.userId,
        errorCode: "insufficient_scope",
      });
      sendForbidden(res, "insufficient_scope");
      return;
    }

    req.agentApiKeyId = apiKey.id;
    req.agentApiKeyPrefix = apiKey.prefix;
    req.userId = apiKey.userId;
    req.scopes = apiKey.scopes;

    try {
      await prisma.agentApiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      // Best-effort bookkeeping — never block a legitimate request over it.
      console.error("Failed to update agent API key lastUsedAt", error);
    }

    next();
  };
};
