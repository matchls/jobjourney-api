import { Router } from "express";
import { requireAgentAuth } from "../middlewares/agent-auth.middleware";
import { agentRateLimit } from "../middlewares/agent-rate-limit.middleware";
import { createAgentApplication } from "../controllers/agent-application.controller";

const router = Router();

router.post(
  "/applications",
  requireAgentAuth("applications:create"),
  agentRateLimit,
  createAgentApplication,
);

export default router;
