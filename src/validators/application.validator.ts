import { z } from "zod";

export const createApplicationSchema = z.object({
  company: z.string().min(1),
  position: z.string().min(1),
  source: z.string().optional(),
  offerUrl: z.string().url().optional(),
  appliedAt: z.string().datetime().optional(),
  resumeText: z.string().optional(),
  coverLetterText: z.string().optional(),
  status: z
    .enum(["TARGETED", "APPLIED", "INTERVIEWING", "OFFER", "REJECTED"])
    .optional(),
});

export const updateApplicationSchema = createApplicationSchema
  .partial()
  .extend({
    status: z
      .enum(["TARGETED", "APPLIED", "INTERVIEWING", "OFFER", "REJECTED"])
      .optional(),
  });

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
