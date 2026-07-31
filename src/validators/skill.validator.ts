import { z } from "zod";

export const createSkillSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const updateSkillSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

export type CreateSkillInput = z.infer<typeof createSkillSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;
