import { z } from "zod";

// Some optional fields have a format constraint (url, email). Browser forms
// send "" rather than omitting the key when the user clears an optional
// input, and "" fails .url()/.email() validation — normalize it to
// `undefined` first so clearing the field doesn't 400 the request.
const emptyToUndefined = (val: unknown) => (val === "" ? undefined : val);
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalEmail = z.preprocess(
  emptyToUndefined,
  z.string().email().optional(),
);

export const createApplicationSchema = z.object({
  company: z.string().min(1),
  position: z.string().min(1),
  source: z.string().optional(),
  offerUrl: optionalUrl,
  appliedAt: z.string().datetime().optional(),
  resumeText: z.string().optional(),
  coverLetterText: z.string().optional(),
  status: z
    .enum(["TARGETED", "APPLIED", "INTERVIEWING", "OFFER", "REJECTED"])
    .optional(),
  notes: z.string().optional(),
  location: z.string().optional(),
  salary: z.string().optional(),
  jobDescription: z.string().optional(),
  contactName: z.string().optional(),
  contactRole: z.string().optional(),
  contactEmail: optionalEmail,
  referralNote: z.string().optional(),
});

export const updateApplicationSchema = createApplicationSchema
  .partial()
  .extend({
    status: z
      .enum(["TARGETED", "APPLIED", "INTERVIEWING", "OFFER", "REJECTED"])
      .optional(),
    // User-facing confirmation that they've reviewed an agent-imported
    // application. Handled explicitly in application.service.ts — never
    // forwarded as-is to Prisma (creationSource/importReviewStatus/etc. are
    // not part of this schema, so the frontend cannot set them directly).
    confirmImportReview: z.literal(true).optional(),
  });

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
