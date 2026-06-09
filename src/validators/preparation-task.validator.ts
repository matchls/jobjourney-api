import { z } from "zod";

export const createPreparationTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  link: z.string().url().optional(),
  order: z.number().int().min(0),
  skillId: z.string().optional(),
});

export const updatePreparationTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  link: z.string().url().optional(),
  isCompleted: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
  skillId: z.string().optional(),
});

export type CreatePreparationTaskInput = z.infer<
  typeof createPreparationTaskSchema
>;
export type UpdatePreparationTaskInput = z.infer<
  typeof updatePreparationTaskSchema
>;
