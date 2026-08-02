// Structured, minimal logging for the agent-import flow. Deliberately never
// receives (and so can never log) a secret, bearer token, hash, idempotency
// key, or request payload — only identifiers and outcomes.
export type AgentLogResult =
  | "created"
  | "duplicate"
  | "idempotent"
  | "rejected"
  | "rate_limited";

export interface AgentLogEntry {
  event: string;
  result: AgentLogResult;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  userId?: string;
  applicationId?: string;
  errorCode?: string;
}

export const logAgentEvent = (entry: AgentLogEntry): void => {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
    }),
  );
};
