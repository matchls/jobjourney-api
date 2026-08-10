import { z } from "zod";

// Source de vérité unique pour les règles de champ réutilisées par plusieurs
// validateurs (formulaire manuel, import agent, extraction d'offre).
//
// Deux familles cohabitent volontairement :
//
//  - "form"    : ce que le navigateur envoie. Un champ optionnel vidé arrive
//                comme "" et non comme une clé absente, et on reste permissif
//                sur le format pour ne pas 400 un formulaire existant.
//  - "machine" : ce qu'un agent ou un extracteur produit. On normalise plus
//                agressivement (trim), on plafonne les longueurs et on durcit
//                les URL, parce que ces payloads n'ont pas les garde-fous
//                d'un formulaire navigateur.
//
// Les valeurs produites par les règles "machine" restent toujours valides pour
// les règles "form" correspondantes (elles sont strictement plus strictes) :
// c'est ce qui garantit qu'un résultat d'extraction peut préremplir
// createApplicationSchema sans revalidation surprise.

// Bornes hautes raisonnables pour qu'un producteur machine défaillant ou
// hostile ne pousse pas des chaînes non bornées à travers l'API.
export const MAX_SHORT_TEXT = 300;
export const MAX_LONG_TEXT = 20000;
export const MAX_URL_LENGTH = 2000;

// --- Normalisation des chaînes vides ---------------------------------------

// Formulaire : le navigateur envoie "" plutôt que d'omettre la clé quand
// l'utilisateur vide un champ optionnel, et "" échoue à .url()/.email().
export const emptyStringToUndefined = (val: unknown) =>
  val === "" ? undefined : val;

// Machine : un producteur qui envoie "" ou "   " pour un champ sans valeur
// doit se comporter exactement comme s'il avait omis le champ.
export const blankStringToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

// --- Règles "form" ---------------------------------------------------------

export const optionalFormUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().url().optional(),
);

export const optionalFormEmail = z.preprocess(
  emptyStringToUndefined,
  z.string().email().optional(),
);

// --- Règles "machine" ------------------------------------------------------

export const requiredText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);

export const optionalText = (maxLength: number) =>
  z.preprocess(
    blankStringToUndefined,
    z.string().trim().max(maxLength).optional(),
  );

export const optionalEmail = (maxLength: number) =>
  z.preprocess(
    blankStringToUndefined,
    z.string().trim().max(maxLength).email().optional(),
  );

const ALLOWED_OFFER_URL_PROTOCOLS = new Set(["http:", "https:"]);

// L'offerUrl n'est jamais fetchée ni rendue par cette API, mais elle EST
// stockée puis renvoyée au frontend — on rejette les schémas qui n'ont de sens
// que comme charge utile d'attaque (javascript:, data:) ou comme vecteur
// SSRF-adjacent (ftp:), ainsi que les identifiants intégrés
// (https://user:pass@host/...).
export const isSafeOfferUrl = (value: string): boolean => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (!ALLOWED_OFFER_URL_PROTOCOLS.has(url.protocol)) {
    return false;
  }

  if (url.username !== "" || url.password !== "") {
    return false;
  }

  return true;
};

export const optionalOfferUrl = (maxLength: number) =>
  z.preprocess(
    blankStringToUndefined,
    z
      .string()
      .trim()
      .max(maxLength)
      .url()
      .refine(isSafeOfferUrl, {
        message:
          "offerUrl doit être une URL http(s) sans identifiants intégrés",
      })
      .optional(),
  );

// Confiance normalisée d'un extracteur/agent sur un champ donné.
export const confidenceScore = z.number().min(0).max(1);
