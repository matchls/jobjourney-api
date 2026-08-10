import { z } from "zod";
import type { CreateApplicationInput } from "./application.validator";
import {
  MAX_LONG_TEXT,
  MAX_SHORT_TEXT,
  MAX_URL_LENGTH,
  confidenceScore,
  optionalEmail,
  optionalOfferUrl,
  optionalText,
} from "./field-rules";

// Contrat d'APERÇU d'une offre extraite, AVANT confirmation utilisateur.
//
// Ce fichier ne décrit ni une candidature persistée, ni un troisième modèle
// parallèle : c'est une vue partielle de createApplicationSchema, limitée aux
// champs qu'on peut réellement lire dans le texte d'une offre, plus des
// métadonnées d'extraction qui ne sont jamais persistées telles quelles.
//
// Rien ici ne crée d'Application : toApplicationPrefill() produit un simple
// objet à afficher dans la modale de nouvelle candidature, que l'utilisateur
// reste libre de corriger avant d'appeler la création existante.

// --- Périmètre des champs extractibles -------------------------------------

// Ce que le texte d'une offre peut légitimement contenir.
export const JOB_OFFER_EXTRACTION_FIELDS = [
  "company",
  "position",
  "source",
  "offerUrl",
  "location",
  "contractType",
  "salary",
  "jobDescription",
  "notes",
  "contactName",
  "contactRole",
  "contactEmail",
] as const;

export type JobOfferExtractionField =
  (typeof JOB_OFFER_EXTRACTION_FIELDS)[number];

// Ce qui relève de l'ACTION ou des données personnelles de l'utilisateur, et
// qu'une extraction ne doit jamais deviner : la date de candidature, le statut
// de suivi, le CV et la lettre, la note de recommandation. Un extracteur qui
// remplirait ces champs inventerait un fait sur l'utilisateur, pas sur l'offre.
export const USER_OWNED_APPLICATION_FIELDS = [
  "appliedAt",
  "status",
  "resumeText",
  "coverLetterText",
  "referralNote",
] as const;

type UserOwnedApplicationField = (typeof USER_OWNED_APPLICATION_FIELDS)[number];

// Assertions vérifiées à la compilation (`npm run build`) : le contrat ne peut
// pas dériver de createApplicationSchema sans casser le build.
type Assert<T extends true> = T;

// 1. Tout champ extrait existe bien sur createApplicationSchema.
type _ExtractedFieldsExistOnApplication = Assert<
  JobOfferExtractionField extends keyof CreateApplicationInput ? true : false
>;

// 2. Aucun champ extrait n'empiète sur les champs possédés par l'utilisateur.
type _NoUserOwnedFieldIsExtracted = Assert<
  Extract<JobOfferExtractionField, UserOwnedApplicationField> extends never
    ? true
    : false
>;

// --- Champs extraits -------------------------------------------------------

// Une extraction est un payload "machine" : on réutilise les règles durcies de
// field-rules.ts (trim, plafonds de longueur, URL http(s) sans identifiants).
// Elles produisent des valeurs strictement plus strictes que celles attendues
// par createApplicationSchema, donc un aperçu valide ici reste valide là-bas.
//
// Tous les champs sont optionnels — y compris company/position, obligatoires à
// la création : une extraction peut légitimement ne rien trouver, et c'est
// l'utilisateur qui complète avant de valider.
export const extractedJobOfferFieldsSchema = z
  .object({
    company: optionalText(MAX_SHORT_TEXT),
    position: optionalText(MAX_SHORT_TEXT),
    source: optionalText(MAX_SHORT_TEXT),
    offerUrl: optionalOfferUrl(MAX_URL_LENGTH),
    location: optionalText(MAX_SHORT_TEXT),
    contractType: optionalText(MAX_SHORT_TEXT),
    salary: optionalText(MAX_SHORT_TEXT),
    jobDescription: optionalText(MAX_LONG_TEXT),
    notes: optionalText(MAX_LONG_TEXT),
    contactName: optionalText(MAX_SHORT_TEXT),
    contactRole: optionalText(MAX_SHORT_TEXT),
    contactEmail: optionalEmail(MAX_SHORT_TEXT),
  })
  .strict();

export type ExtractedJobOfferFields = z.infer<
  typeof extractedJobOfferFieldsSchema
>;

// 3. La liste JOB_OFFER_EXTRACTION_FIELDS et le schéma ne peuvent pas diverger.
type _SchemaCoversFieldList = Assert<
  JobOfferExtractionField extends keyof ExtractedJobOfferFields ? true : false
>;
type _FieldListCoversSchema = Assert<
  keyof ExtractedJobOfferFields extends JobOfferExtractionField ? true : false
>;

// --- Métadonnées d'extraction (non persistées) -----------------------------

const MAX_WARNINGS = 20;

// z.record() avec des clés d'enum est EXHAUSTIF en Zod 4 (il exigerait les 12
// champs) : c'est partialRecord qu'il faut ici. Bénéfice au passage, les clés
// inconnues sont rejetées sans refine supplémentaire.
const confidenceByFieldSchema = z
  .partialRecord(z.enum(JOB_OFFER_EXTRACTION_FIELDS), confidenceScore)
  .optional();

// Champs que l'utilisateur devra vérifier. Enum fermé : un extracteur ne peut
// pas signaler un champ hors périmètre, et le frontend peut mapper ces noms
// directement sur ses inputs.
const uncertainFieldsSchema = z
  .array(z.enum(JOB_OFFER_EXTRACTION_FIELDS))
  .max(JOB_OFFER_EXTRACTION_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, {
    message: "uncertainFields ne doit pas contenir de doublon",
  })
  .optional();

// Ambiguïtés à afficher à l'utilisateur. Texte libre, donc borné en longueur
// et en nombre : c'est le seul champ du contrat où un extracteur pourrait
// recopier du contenu arbitraire de l'offre.
const warningsSchema = z
  .array(z.string().trim().min(1).max(MAX_SHORT_TEXT))
  .max(MAX_WARNINGS)
  .optional();

export const jobOfferExtractionResultSchema = z
  .object({
    fields: extractedJobOfferFieldsSchema.default({}),
    confidenceByField: confidenceByFieldSchema,
    uncertainFields: uncertainFieldsSchema,
    warnings: warningsSchema,
  })
  .strict();

export type JobOfferExtractionResult = z.infer<
  typeof jobOfferExtractionResultSchema
>;

// --- Mapping vers la création de candidature existante ----------------------

// Sous-ensemble de createApplicationSchema qu'une extraction peut préremplir.
export type ApplicationPrefill = Partial<
  Pick<CreateApplicationInput, JobOfferExtractionField>
>;

// Traduit un résultat d'extraction en valeurs de préremplissage pour la modale
// de nouvelle candidature. Fonction pure : aucune écriture en base, aucune
// métadonnée d'extraction recopiée dans la candidature.
//
// Les champs absents sont omis plutôt que mis à "" pour que le frontend
// distingue "non extrait" de "extrait vide", et pour que le résultat reste
// parsable tel quel par createApplicationSchema.partial().
export const toApplicationPrefill = ({
  fields,
}: JobOfferExtractionResult): ApplicationPrefill =>
  // Le schéma est .strict() : les clés de `fields` sont exactement celles du
  // contrat, seules les valeurs undefined sont à filtrer.
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as ApplicationPrefill;
