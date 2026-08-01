import { Router } from "express";
import {
  register,
  login,
  logout,
  getMe,
  googleRedirect,
  googleCallback,
} from "../controllers/auth.controller";
import { authenticate } from "../middlewares/auth.middleware";
const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.get("/me", authenticate, getMe);
router.get("/google", googleRedirect);
router.get("/google/callback", googleCallback);

export default router;
