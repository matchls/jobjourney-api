import { z } from "zod";

// Reasonable upper bounds so a misbehaving or adversarial agent can't push
// unbounded strings/arrays through this route (it skips the normal cookie
// auth + browser form constraints the rest of the API relies on).
const MAX_SHORT_TEXT = 300;
const MAX_LONG_TEXT = 20000;
const MAX_URL_LENGTH = 2000;
const MAX_STACK_ITEMS = 50;
const MAX_STACK_ITEM_LENGTH = 100;
const MAX_UNCERTAIN_FIELDS = 30;
const MAX_FIELD_NAME_LENGTH = 100;
const MAX_CONFIDENCE_ENTRIES = 30;

// An agent sending "" for a field it has no value for should behave like
// omitting the field entirely, same convention as the human-facing
// application.validator.ts.
const emptyToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

const requiredText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);

const optionalText = (maxLength: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(maxLength).optional());

const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().trim().max(MAX_URL_LENGTH).url().optional(),
);

const stackSchema = z
  .array(z.string().trim().min(1).max(MAX_STACK_ITEM_LENGTH))
  .max(MAX_STACK_ITEMS)
  .optional();

const uncertainFieldsSchema = z
  .array(z.string().trim().min(1).max(MAX_FIELD_NAME_LENGTH))
  .max(MAX_UNCERTAIN_FIELDS)
  .optional();

const confidenceByFieldSchema = z
  .record(
    z.string().trim().min(1).max(MAX_FIELD_NAME_LENGTH),
    z.number().min(0).max(1),
  )
  .refine((entries) => Object.keys(entries).length <= MAX_CONFIDENCE_ENTRIES, {
    message: `confidenceByField accepte au maximum ${MAX_CONFIDENCE_ENTRIES} champs`,
  })
  .optional();

const agentAnalysisSchema = z
  .object({
    summary: optionalText(MAX_LONG_TEXT),
    score: z.number().min(0).max(100).optional(),
    confidenceByField: confidenceByFieldSchema,
    uncertainFields: uncertainFieldsSchema,
  })
  .strict()
  .optional();

export const createAgentApplicationSchema = z
  .object({
    company: requiredText(MAX_SHORT_TEXT),
    position: requiredText(MAX_SHORT_TEXT),
    offerUrl: optionalUrl,
    location: optionalText(MAX_SHORT_TEXT),
    contractType: optionalText(MAX_SHORT_TEXT),
    salary: optionalText(MAX_SHORT_TEXT),
    jobDescription: optionalText(MAX_LONG_TEXT),
    notes: optionalText(MAX_LONG_TEXT),
    source: optionalText(MAX_SHORT_TEXT),
    stack: stackSchema,
    agentAnalysis: agentAnalysisSchema,
  })
  .strict();

export type CreateAgentApplicationInput = z.infer<
  typeof createAgentApplicationSchema
>;

export const idempotencyKeySchema = z.string().trim().min(1).max(128);
