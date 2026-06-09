import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { getProfile, updateProfile } from "../controllers/user.controller";

const router = Router();

router.use(authenticate);

router.get("/me", getProfile);
router.patch("/me", updateProfile);

export default router;
