import { Response } from "express";
import { AgentAuthRequest } from "../middlewares/agent-auth.middleware";
import {
  createAgentApplicationSchema,
  idempotencyKeySchema,
} from "../validators/agent-application.validator";
import { importAgentApplication } from "../services/agent-application.service";
import { logAgentEvent } from "../utils/agent-logger";

const sendValidationError = (
  res: Response,
  fieldErrors: Record<string, string[]>,
  formErrors: string[],
) => {
  res.status(400).json({
    error: { code: "validation_error", fieldErrors, formErrors },
  });
};

export const createAgentApplication = async (
  req: AgentAuthRequest,
  res: Response,
) => {
  const logBase = {
    apiKeyId: req.agentApiKeyId,
    apiKeyPrefix: req.agentApiKeyPrefix,
    userId: req.userId,
  };

  const rawIdempotencyKey = req.headers["idempotency-key"];
  const idempotencyKeyResult = idempotencyKeySchema.safeParse(
    Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey,
  );

  if (!idempotencyKeyResult.success) {
    logAgentEvent({
      event: "agent_application_import",
      result: "rejected",
      ...logBase,
      errorCode: "invalid_idempotency_key",
    });
    sendValidationError(
      res,
      { "Idempotency-Key": ["En-tête Idempotency-Key requis (1 à 128 caractères)"] },
      [],
    );
    return;
  }

  const parsedBody = createAgentApplicationSchema.safeParse(req.body);

  if (!parsedBody.success) {
    const flattened = parsedBody.error.flatten();
    logAgentEvent({
      event: "agent_application_import",
      result: "rejected",
      ...logBase,
      errorCode: "validation_error",
    });
    sendValidationError(res, flattened.fieldErrors, flattened.formErrors);
    return;
  }

  const outcome = await importAgentApplication(
    {
      userId: req.userId!,
      apiKeyId: req.agentApiKeyId!,
      idempotencyKey: idempotencyKeyResult.data,
    },
    parsedBody.data,
  );

  switch (outcome.kind) {
    case "created": {
      logAgentEvent({
        event: "agent_application_import",
        result: "created",
        ...logBase,
        applicationId: outcome.applicationId,
      });
      res.status(201).json({
        status: "created",
        applicationId: outcome.applicationId,
        duplicate: false,
        idempotent: false,
      });
      return;
    }
    case "duplicate": {
      logAgentEvent({
        event: "agent_application_import",
        result: "duplicate",
        ...logBase,
        applicationId: outcome.applicationId,
      });
      res.status(200).json({
        status: "duplicate",
        applicationId: outcome.applicationId,
        duplicate: true,
        idempotent: false,
      });
      return;
    }
    case "idempotent": {
      const isDuplicate = outcome.result === "DUPLICATE";
      logAgentEvent({
        event: "agent_application_import",
        result: "idempotent",
        ...logBase,
        applicationId: outcome.applicationId,
      });
      res.status(200).json({
        status: isDuplicate ? "duplicate" : "created",
        applicationId: outcome.applicationId,
        duplicate: isDuplicate,
        idempotent: true,
      });
      return;
    }
    case "idempotency_conflict": {
      logAgentEvent({
        event: "agent_application_import",
        result: "rejected",
        ...logBase,
        errorCode: "idempotency_conflict",
      });
      res.status(409).json({ error: { code: "idempotency_conflict" } });
      return;
    }
  }
};
