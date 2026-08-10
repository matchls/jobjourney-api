import { z } from "zod";
import {
  MAX_LONG_TEXT,
  MAX_SHORT_TEXT,
  MAX_URL_LENGTH,
  optionalOfferUrl,
  optionalText,
} from "./field-rules";

// Entrée de POST /applications/parse-offer.
//
// Le texte collé par l'utilisateur est un payload "machine" au sens de
// field-rules.ts : on réutilise les mêmes règles durcies que l'import agent
// (trim, longueurs bornées, URL http(s) sans identifiants intégrés) plutôt que
// d'en réinventer.

// Limite documentée du texte d'offre. Au-delà, rejet explicite par la
// validation (400) plutôt que troncature silencieuse : une offre tronquée
// produirait une extraction partielle sans que l'utilisateur le sache.
// Une annonce réelle dépasse rarement quelques milliers de caractères.
export const MAX_OFFER_TEXT_LENGTH = MAX_LONG_TEXT;

export const parseOfferSchema = z
  .object({
    // .trim() puis .min(1) : "" et une suite d'espaces sont refusés de la même
    // manière, avant tout appel au fournisseur.
    offerText: z.string().trim().min(1).max(MAX_OFFER_TEXT_LENGTH),
    offerUrl: optionalOfferUrl(MAX_URL_LENGTH),
    sourceHint: optionalText(MAX_SHORT_TEXT),
  })
  .strict();

export type ParseOfferInput = z.infer<typeof parseOfferSchema>;
