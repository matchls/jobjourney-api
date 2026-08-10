import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { parseOfferSchema } from "../validators/parse-offer.validator";
import { extractJobOffer } from "../services/job-offer-extraction.service";
import {
  JobOfferExtractionError,
  JobOfferExtractionErrorCode,
} from "../services/job-offer-extraction.provider";
import { logExtractionEvent } from "../utils/extraction-logger";

// Correspondance figée entre code applicatif et statut HTTP. Le frontend peut
// s'appuyer dessus : le code ne change pas si l'on change de fournisseur.
const STATUS_BY_ERROR_CODE: Record<JobOfferExtractionErrorCode, number> = {
  // Le service ne peut pas fonctionner ici et maintenant, mais le reste de
  // l'API (dont la création manuelle) est intact : 503 et pas 500.
  extraction_not_configured: 503,
  extraction_timeout: 504,
  extraction_rate_limited: 429,
  extraction_unavailable: 502,
  extraction_invalid_response: 502,
};

export const parseOffer = async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const parsedBody = parseOfferSchema.safeParse(req.body);

  if (!parsedBody.success) {
    const flattened = parsedBody.error.flatten();
    logExtractionEvent({
      event: "job_offer_extraction",
      result: "rejected",
      userId,
      errorCode: "validation_error",
    });
    res.status(400).json({
      error: {
        code: "validation_error",
        fieldErrors: flattened.fieldErrors,
        formErrors: flattened.formErrors,
      },
    });
    return;
  }

  const startedAt = Date.now();

  try {
    // Seuls ces trois champs partent chez le fournisseur. Ils sont recopiés
    // explicitement, un par un : impossible qu'un futur champ du body — ou
    // une donnée de session — parte par inadvertance.
    const preview = await extractJobOffer({
      offerText: parsedBody.data.offerText,
      offerUrl: parsedBody.data.offerUrl,
      sourceHint: parsedBody.data.sourceHint,
    });

    logExtractionEvent({
      event: "job_offer_extraction",
      result: "succeeded",
      userId,
      offerTextLength: parsedBody.data.offerText.length,
      durationMs: Date.now() - startedAt,
    });

    // Aucune candidature n'a été créée : c'est un aperçu à confirmer par
    // l'utilisateur via POST /applications.
    res.status(200).json(preview);
  } catch (error) {
    if (error instanceof JobOfferExtractionError) {
      logExtractionEvent({
        event: "job_offer_extraction",
        result: "failed",
        userId,
        errorCode: error.code,
        offerTextLength: parsedBody.data.offerText.length,
        durationMs: Date.now() - startedAt,
      });
      res
        .status(STATUS_BY_ERROR_CODE[error.code])
        .json({ error: { code: error.code } });
      return;
    }

    // Erreur inattendue : on ne laisse pas remonter au handler global, qui
    // logue err.stack — un stack inconnu pourrait embarquer du texte d'offre.
    logExtractionEvent({
      event: "job_offer_extraction",
      result: "failed",
      userId,
      errorCode: "extraction_unexpected_error",
      durationMs: Date.now() - startedAt,
    });
    res.status(500).json({ error: { code: "extraction_unexpected_error" } });
  }
};
