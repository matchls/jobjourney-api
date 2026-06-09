import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  createApplicationSchema,
  updateApplicationSchema,
} from "../validators/application.validator";
import * as applicationService from "../services/application.service";

export const getApplications = async (req: AuthRequest, res: Response) => {
  const applications = await applicationService.getApplications(req.userId!);
  res.status(200).json(applications);
};

export const getApplicationById = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const application = await applicationService.getApplicationById(
      id,
      req.userId!,
    );
    res.status(200).json(application);
  } catch {
    res.status(404).json({ error: "Application not found" });
  }
};

export const createApplication = async (req: AuthRequest, res: Response) => {
  const parsed = createApplicationSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const application = await applicationService.createApplication(
    req.userId!,
    parsed.data,
  );
  res.status(201).json(application);
};

export const updateApplication = async (req: AuthRequest, res: Response) => {
  const parsed = updateApplicationSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const id = req.params.id as string;
    const application = await applicationService.updateApplication(
      id,
      req.userId!,
      parsed.data,
    );
    res.status(200).json(application);
  } catch {
    res.status(404).json({ error: "Application not found" });
  }
};

export const deleteApplication = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;
  try {
    await applicationService.deleteApplication(id, req.userId!);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Application not found" });
  }
};
