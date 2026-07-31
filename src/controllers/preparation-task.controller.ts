import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  createPreparationTaskSchema,
  updatePreparationTaskSchema,
} from "../validators/preparation-task.validator";
import * as preparationTaskService from "../services/preparation-task.service";

export const getPreparationTasks = async (req: AuthRequest, res: Response) => {
  try {
    const applicationId = req.params.id as string;
    const tasks = await preparationTaskService.getPreparationTasks(
      applicationId,
      req.userId!,
    );
    res.status(200).json(tasks);
  } catch {
    res.status(404).json({ error: "Application not found" });
  }
};

export const createPreparationTask = async (
  req: AuthRequest,
  res: Response,
) => {
  const parsed = createPreparationTaskSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const applicationId = req.params.id as string;
    const task = await preparationTaskService.createPreparationTask(
      applicationId,
      req.userId!,
      parsed.data,
    );
    res.status(201).json(task);
  } catch (error: any) {
    if (error.message === "INVALID_SKILLS") {
      res.status(400).json({ error: "Invalid skill" });
      return;
    }
    res.status(404).json({ error: "Application not found" });
  }
};

export const updatePreparationTask = async (
  req: AuthRequest,
  res: Response,
) => {
  const parsed = updatePreparationTaskSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const taskId = req.params.taskId as string;
    const task = await preparationTaskService.updatePreparationTask(
      taskId,
      req.userId!,
      parsed.data,
    );
    res.status(200).json(task);
  } catch (error: any) {
    if (error.message === "INVALID_SKILLS") {
      res.status(400).json({ error: "Invalid skill" });
      return;
    }
    res.status(404).json({ error: "Preparation task not found" });
  }
};

export const deletePreparationTask = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const taskId = req.params.taskId as string;
    await preparationTaskService.deletePreparationTask(taskId, req.userId!);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Preparation task not found" });
  }
};
