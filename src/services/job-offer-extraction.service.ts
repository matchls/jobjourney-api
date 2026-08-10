import {
  JobOfferExtractionResult,
  jobOfferExtractionResultSchema,
} from "../validators/job-offer-extraction.validator";
import { createGroqJobOfferExtractionProvider } from "./groq-job-offer-extraction.provider";
import {
  JobOfferExtractionError,
  JobOfferExtractionInput,
  JobOfferExtractionProvider,
} from "./job-offer-extraction.provider";

// Service métier de l'extraction d'offre.
//
// Ce fichier n'importe volontairement PAS prisma : il n'a aucun moyen
// d'écrire en base. C'est la garantie structurelle qu'analyser une offre ne
// crée jamais de candidature — pas une simple promesse de code review.

const defaultProvider = createGroqJobOfferExtractionProvider();

let providerOverride: JobOfferExtractionProvider | null = null;

// Même convention que __resetAgentRateLimitStateForTests : point d'injection
// réservé aux tests, pour couvrir le flux HTTP complet sans clé ni réseau.
export const __setJobOfferExtractionProviderForTests = (
  provider: JobOfferExtractionProvider | null,
): void => {
  providerOverride = provider;
};

export const extractJobOffer = async (
  input: JobOfferExtractionInput,
): Promise<JobOfferExtractionResult> => {
  const provider = providerOverride ?? defaultProvider;

  const raw = await provider.extract(input);

  // Revalidation systématique, même si le fournisseur annonce une conformité
  // JSON Schema garantie : le strict mode peut être désactivé, le modèle peut
  // changer, un futur fournisseur peut ne rien garantir du tout. Le contrat
  // #16 est la seule autorité sur ce qui sort d'ici.
  const parsed = jobOfferExtractionResultSchema.safeParse(raw);

  if (!parsed.success) {
    // L'erreur Zod détaillée n'est pas propagée : elle contiendrait des
    // fragments de la réponse du modèle, donc potentiellement du texte
    // d'offre.
    throw new JobOfferExtractionError("extraction_invalid_response");
  }

  return parsed.data;
};
