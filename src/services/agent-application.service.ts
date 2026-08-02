import { Prisma, AgentImportReceiptResult } from "@prisma/client";
import prisma from "../config/prisma";
import { CreateAgentApplicationInput } from "../validators/agent-application.validator";
import { computeAgentDedupKey, computeRequestHash } from "../utils/agent-dedup";
import { findApplicationMatchingDedupKey } from "./application-dedup-lookup.service";

export interface AgentImportContext {
  userId: string;
  apiKeyId: string;
  idempotencyKey: string;
}

export type AgentImportOutcome =
  | { kind: "created"; applicationId: string }
  | { kind: "duplicate"; applicationId: string }
  | {
      kind: "idempotent";
      applicationId: string;
      result: AgentImportReceiptResult;
    }
  | { kind: "idempotency_conflict" };

class IdempotencyConflictError extends Error {
  constructor() {
    super("IDEMPOTENCY_CONFLICT");
  }
}

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

// Postgres reports a serialization failure (SQLSTATE 40001) when two
// SERIALIZABLE transactions overlap in a way that couldn't happen in any
// serial ordering; Prisma surfaces it as P2034.
const isSerializationFailure = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2034";

const MAX_SERIALIZATION_RETRIES = 3;

// The dedup pre-check (findApplicationMatchingDedupKey) scans ALL of a
// user's applications rather than looking up a single indexed
// agentDedupKey — necessary for the mixed URL/fallback rule, since a
// duplicate can be a row with a *different* agentDedupKey value (one side
// has an offerUrl, the other doesn't). That means the unique DB constraint
// alone can't catch a race between two such "cross-shaped" concurrent
// imports for the same job — both would compute different agentDedupKey
// values and neither INSERT would violate the index. Running the whole
// check-then-create sequence under SERIALIZABLE isolation makes Postgres
// itself detect that overlap (a classic read-then-insert write skew) and
// abort one of the two transactions with a serialization failure instead of
// silently letting both commit. Retrying re-runs the callback from scratch:
// on the retry, the pre-check sees whatever the winning transaction just
// committed and correctly resolves to a duplicate rather than racing again.
const runInSerializableTransaction = async <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationFailure(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError;
};

// Only stores what an operator reviewing an import would need: the stack the
// agent detected, its synthesis, its confidence score/breakdown. Never the
// idempotency key, the bearer secret, or its hash.
const buildAgentImportMetadata = (
  data: CreateAgentApplicationInput,
): Prisma.InputJsonValue | undefined => {
  const metadata: Record<string, unknown> = {};

  if (data.stack && data.stack.length > 0) {
    metadata.stack = data.stack;
  }
  if (data.agentAnalysis?.summary) {
    metadata.summary = data.agentAnalysis.summary;
  }
  if (data.agentAnalysis?.score !== undefined) {
    metadata.score = data.agentAnalysis.score;
  }
  if (data.agentAnalysis?.confidenceByField) {
    metadata.confidenceByField = data.agentAnalysis.confidenceByField;
  }

  return Object.keys(metadata).length > 0
    ? (metadata as Prisma.InputJsonValue)
    : undefined;
};

const findReceipt = (
  client: Prisma.TransactionClient | typeof prisma,
  apiKeyId: string,
  idempotencyKey: string,
) =>
  client.agentImportReceipt.findUnique({
    where: { apiKeyId_idempotencyKey: { apiKeyId, idempotencyKey } },
  });

const outcomeFromReceipt = (
  receipt: { applicationId: string; requestHash: string; result: AgentImportReceiptResult },
  requestHash: string,
): AgentImportOutcome => {
  if (receipt.requestHash !== requestHash) {
    return { kind: "idempotency_conflict" };
  }
  return {
    kind: "idempotent",
    applicationId: receipt.applicationId,
    result: receipt.result,
  };
};

// Resolves the case where two concurrent requests both passed the read-only
// pre-checks and raced each other into the transaction below — one of them
// hits a unique-constraint violation (P2002) instead of a clean early
// return. We don't know from the error alone *which* constraint fired (the
// idempotency key or the dedup key), so we re-read the actual state and
// apply the same decision logic a non-racing request would have used.
const resolveConcurrentConflict = async (
  context: AgentImportContext,
  requestHash: string,
  dedupKey: string,
): Promise<AgentImportOutcome> => {
  const receipt = await findReceipt(
    prisma,
    context.apiKeyId,
    context.idempotencyKey,
  );

  if (receipt) {
    return outcomeFromReceipt(receipt, requestHash);
  }

  const application = await prisma.application.findUnique({
    where: {
      userId_agentDedupKey: { userId: context.userId, agentDedupKey: dedupKey },
    },
  });

  if (!application) {
    throw new Error("AGENT_IMPORT_CONFLICT_UNRESOLVED");
  }

  try {
    const createdReceipt = await prisma.agentImportReceipt.create({
      data: {
        apiKeyId: context.apiKeyId,
        userId: context.userId,
        idempotencyKey: context.idempotencyKey,
        requestHash,
        applicationId: application.id,
        result: "DUPLICATE",
      },
    });
    return { kind: "duplicate", applicationId: createdReceipt.applicationId };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raceReceipt = await findReceipt(
        prisma,
        context.apiKeyId,
        context.idempotencyKey,
      );
      if (raceReceipt) {
        return outcomeFromReceipt(raceReceipt, requestHash);
      }
    }
    throw error;
  }
};

export const importAgentApplication = async (
  context: AgentImportContext,
  data: CreateAgentApplicationInput,
): Promise<AgentImportOutcome> => {
  const requestHash = computeRequestHash(data);

  const existingReceipt = await findReceipt(
    prisma,
    context.apiKeyId,
    context.idempotencyKey,
  );

  if (existingReceipt) {
    return outcomeFromReceipt(existingReceipt, requestHash);
  }

  const dedupCandidate = {
    offerUrl: data.offerUrl,
    company: data.company,
    position: data.position,
    location: data.location,
  };
  const dedupKey = computeAgentDedupKey(dedupCandidate);

  try {
    return await runInSerializableTransaction(async (tx) => {
      const raceReceipt = await findReceipt(
        tx,
        context.apiKeyId,
        context.idempotencyKey,
      );

      if (raceReceipt) {
        const outcome = outcomeFromReceipt(raceReceipt, requestHash);
        if (outcome.kind === "idempotency_conflict") {
          throw new IdempotencyConflictError();
        }
        return outcome;
      }

      const existingApplication = await findApplicationMatchingDedupKey(
        tx,
        context.userId,
        dedupCandidate,
      );

      if (existingApplication) {
        await tx.agentImportReceipt.create({
          data: {
            apiKeyId: context.apiKeyId,
            userId: context.userId,
            idempotencyKey: context.idempotencyKey,
            requestHash,
            applicationId: existingApplication.id,
            result: "DUPLICATE",
          },
        });
        return {
          kind: "duplicate" as const,
          applicationId: existingApplication.id,
        };
      }

      const uncertainFields = data.agentAnalysis?.uncertainFields ?? [];

      const application = await tx.application.create({
        data: {
          company: data.company,
          position: data.position,
          source: data.source,
          offerUrl: data.offerUrl,
          location: data.location,
          contractType: data.contractType,
          salary: data.salary,
          jobDescription: data.jobDescription,
          notes: data.notes,
          status: "TARGETED",
          statusChangedAt: new Date(),
          userId: context.userId,
          creationSource: "AGENT_IMPORT",
          importedByApiKeyId: context.apiKeyId,
          agentDedupKey: dedupKey,
          uncertainFields,
          importReviewStatus:
            uncertainFields.length > 0 ? "PENDING" : "NOT_REQUIRED",
          agentImportMetadata: buildAgentImportMetadata(data),
        },
      });

      await tx.agentImportReceipt.create({
        data: {
          apiKeyId: context.apiKeyId,
          userId: context.userId,
          idempotencyKey: context.idempotencyKey,
          requestHash,
          applicationId: application.id,
          result: "CREATED",
        },
      });

      return { kind: "created" as const, applicationId: application.id };
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return { kind: "idempotency_conflict" };
    }

    if (isUniqueConstraintError(error)) {
      return resolveConcurrentConflict(context, requestHash, dedupKey);
    }

    throw error;
  }
};
