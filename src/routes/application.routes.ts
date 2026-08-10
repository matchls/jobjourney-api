import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
  getApplications,
  getApplicationById,
  createApplication,
  updateApplication,
  deleteApplication,
} from "../controllers/application.controller";
import { parseOffer } from "../controllers/job-offer-extraction.controller";
import { parseOfferRateLimit } from "../middlewares/parse-offer-rate-limit.middleware";

const router = Router();

router.use(authenticate);

// Analyse d'une offre pour préremplir le formulaire — ne crée rien. Déclarée
// avant les routes paramétrées pour rester lisible : "parse-offer" est un
// chemin fixe, jamais un identifiant de candidature.
//
// Auth utilisateur classique (cookie JWT) : la clé agent n'ouvre pas cette
// route, elle est réservée à POST /agent/applications.
router.post("/parse-offer", parseOfferRateLimit, parseOffer);

router.get("/", getApplications);
router.get("/:id", getApplicationById);
router.post("/", createApplication);
router.patch("/:id", updateApplication);
router.delete("/:id", deleteApplication);

export default router;
