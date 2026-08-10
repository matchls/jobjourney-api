// Frontière entre le domaine candidature et le fournisseur IA.
//
// Ce fichier n'importe RIEN de Groq : c'est le contrat que le service métier
// connaît. Un futur fournisseur n'a qu'à implémenter cette interface, sans
// qu'aucun contrôleur ni service candidature ne change. Pas de multi-provider
// dans cette PR — seulement une architecture qui ne l'empêche pas.

// Ce qu'on accepte d'envoyer à un fournisseur externe : le texte de l'offre et,
// au plus, deux indices de provenance. Jamais de profil utilisateur, d'email de
// connexion, de CV, de lettre ou de quoi que ce soit venant du compte Job
// Journey. Le type lui-même sert de garde-fou : il n'y a pas de champ où
// glisser une donnée personnelle.
export interface JobOfferExtractionInput {
  offerText: string;
  offerUrl?: string;
  sourceHint?: string;
}

// Codes d'erreur applicatifs stables. Ils sont exposés tels quels au frontend,
// donc ils ne doivent jamais dépendre du fournisseur : pas de statut Groq
// brut, pas de message d'erreur recopié, aucune fuite de configuration.
export type JobOfferExtractionErrorCode =
  // GROQ_API_KEY absente, ou refusée par le fournisseur : c'est une
  // configuration serveur, pas un problème de la requête utilisateur.
  | "extraction_not_configured"
  // Le fournisseur n'a pas répondu dans le délai imparti.
  | "extraction_timeout"
  // Quota / rate limit du fournisseur (429).
  | "extraction_rate_limited"
  // Fournisseur indisponible (5xx, capacité, panne réseau).
  | "extraction_unavailable"
  // Réponse reçue mais inexploitable : JSON invalide, enveloppe inattendue,
  // ou contenu qui ne passe pas le contrat Zod de #16.
  | "extraction_invalid_response";

export class JobOfferExtractionError extends Error {
  constructor(public readonly code: JobOfferExtractionErrorCode) {
    // Le message ne contient que le code : cette erreur peut remonter jusqu'au
    // handler global qui log `err.stack`, donc elle ne doit jamais transporter
    // de texte d'offre, de réponse brute du modèle ni de secret.
    super(code);
    this.name = "JobOfferExtractionError";
  }
}

export interface JobOfferExtractionProvider {
  // Retourne volontairement `unknown` : la donnée sort d'un modèle de langage,
  // elle n'est pas digne de confiance tant qu'elle n'a pas repassé le schéma
  // Zod de #16. Le type force la revalidation côté service — il est
  // impossible d'utiliser ce retour sans le parser d'abord.
  extract(input: JobOfferExtractionInput): Promise<unknown>;
}
