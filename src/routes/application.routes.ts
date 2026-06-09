import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
  getApplications,
  getApplicationById,
  createApplication,
  updateApplication,
  deleteApplication,
} from "../controllers/application.controller";

const router = Router();

router.use(authenticate);

router.get("/", getApplications);
router.get("/:id", getApplicationById);
router.post("/", createApplication);
router.patch("/:id", updateApplication);
router.delete("/:id", deleteApplication);

export default router;
