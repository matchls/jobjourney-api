import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
  getInterviewSteps,
  createInterviewStep,
  updateInterviewStep,
  deleteInterviewStep,
} from "../controllers/interview-step.controller";

const router = Router({ mergeParams: true });

router.use(authenticate);

router.get("/", getInterviewSteps);
router.post("/", createInterviewStep);
router.patch("/:stepId", updateInterviewStep);
router.delete("/:stepId", deleteInterviewStep);

export default router;
