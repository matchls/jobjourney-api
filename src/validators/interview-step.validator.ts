import { z } from "zod";

export const createInterviewStepSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["HR", "TECHNICAL", "FINAL", "CUSTOM"]),
  scheduledAt: z.string().datetime().optional(),
  order: z.number().int().min(0),
});

export const updateInterviewStepSchema = z.object({
  title: z.string().min(1).optional(),
  type: z.enum(["HR", "TECHNICAL", "FINAL", "CUSTOM"]).optional(),
  status: z.enum(["PLANNED", "COMPLETED", "CANCELLED"]).optional(),
  scheduledAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  questionsAsked: z.string().optional(),
  blockers: z.string().optional(),
  toReview: z.string().optional(),
  notes: z.string().optional(),
  order: z.number().int().min(0).optional(),
});

export type CreateInterviewStepInput = z.infer<
  typeof createInterviewStepSchema
>;
export type UpdateInterviewStepInput = z.infer<
  typeof updateInterviewStepSchema
>;
