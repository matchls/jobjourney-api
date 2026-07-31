import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
  getSkills,
  createSkill,
  updateSkill,
  deleteSkill,
} from "../controllers/skill.controller";

const router = Router();

router.use(authenticate);

router.get("/", getSkills);
router.post("/", createSkill);
router.patch("/:id", updateSkill);
router.delete("/:id", deleteSkill);

export default router;
