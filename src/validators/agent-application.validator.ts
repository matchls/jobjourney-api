import { z } from "zod";
import {
  MAX_LONG_TEXT,
  MAX_SHORT_TEXT,
  MAX_URL_LENGTH,
  confidenceScore,
  optionalOfferUrl,
  optionalText,
  requiredText,
} from "./field-rules";

// Bornes propres au flux agent (le reste des bornes de longueur et les règles
// de normalisation vivent dans field-rules.ts, partagées avec les autres
// producteurs "machine").
const MAX_STACK_ITEMS = 50;
const MAX_STACK_ITEM_LENGTH = 100;
const MAX_UNCERTAIN_FIELDS = 30;
const MAX_FIELD_NAME_LENGTH = 100;
const MAX_CONFIDENCE_ENTRIES = 30;

const stackSchema = z
  .array(z.string().trim().min(1).max(MAX_STACK_ITEM_LENGTH))
  .max(MAX_STACK_ITEMS)
  .optional();

// Le flux agent accepte des noms de champ libres (l'agent peut annoter des
// champs qui ne sont pas ceux de l'Application), d'où les clés en string
// plutôt qu'un enum fermé comme dans le contrat d'extraction.
const uncertainFieldsSchema = z
  .array(z.string().trim().min(1).max(MAX_FIELD_NAME_LENGTH))
  .max(MAX_UNCERTAIN_FIELDS)
  .optional();

const confidenceByFieldSchema = z
  .record(z.string().trim().min(1).max(MAX_FIELD_NAME_LENGTH), confidenceScore)
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
    offerUrl: optionalOfferUrl(MAX_URL_LENGTH),
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
