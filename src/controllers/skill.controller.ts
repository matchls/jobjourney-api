import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import {
  createSkillSchema,
  updateSkillSchema,
} from "../validators/skill.validator";
import * as skillService from "../services/skill.service";

export const getSkills = async (req: AuthRequest, res: Response) => {
  const skills = await skillService.getSkills(req.userId!);
  res.status(200).json(skills);
};

export const createSkill = async (req: AuthRequest, res: Response) => {
  const parsed = createSkillSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const skill = await skillService.createSkill(req.userId!, parsed.data);
  res.status(201).json(skill);
};

export const updateSkill = async (req: AuthRequest, res: Response) => {
  const parsed = updateSkillSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const id = req.params.id as string;
    const skill = await skillService.updateSkill(id, req.userId!, parsed.data);
    res.status(200).json(skill);
  } catch {
    res.status(404).json({ error: "Skill not found" });
  }
};

export const deleteSkill = async (req: AuthRequest, res: Response) => {
  const id = req.params.id as string;

  try {
    await skillService.deleteSkill(id, req.userId!);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Skill not found" });
  }
};
