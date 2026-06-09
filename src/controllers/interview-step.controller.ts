import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  createInterviewStepSchema,
  updateInterviewStepSchema,
} from "../validators/interview-step.validator";
import * as interviewStepService from "../services/interview-step.service";

export const getInterviewSteps = async (req: AuthRequest, res: Response) => {
  try {
    const applicationId = req.params.id as string;
    const steps = await interviewStepService.getInterviewSteps(
      applicationId,
      req.userId!,
    );
    res.status(200).json(steps);
  } catch {
    res.status(404).json({ error: "Application not found" });
  }
};

export const createInterviewStep = async (req: AuthRequest, res: Response) => {
  const parsed = createInterviewStepSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const applicationId = req.params.id as string;
    const step = await interviewStepService.createInterviewStep(
      applicationId,
      req.userId!,
      parsed.data,
    );
    res.status(201).json(step);
  } catch {
    res.status(404).json({ error: "Application not found" });
  }
};

export const updateInterviewStep = async (req: AuthRequest, res: Response) => {
  const parsed = updateInterviewStepSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const stepId = req.params.stepId as string;
    const step = await interviewStepService.updateInterviewStep(
      stepId,
      req.userId!,
      parsed.data,
    );
    res.status(200).json(step);
  } catch {
    res.status(404).json({ error: "Interview step not found" });
  }
};

export const deleteInterviewStep = async (req: AuthRequest, res: Response) => {
  try {
    const stepId = req.params.stepId as string;
    await interviewStepService.deleteInterviewStep(stepId, req.userId!);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Interview step not found" });
  }
};
