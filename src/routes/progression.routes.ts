import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { getProgression } from "../controllers/progression.controller";

const router = Router();

router.get("/", authenticate, getProgression);
export default router;
