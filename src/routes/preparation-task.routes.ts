import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import {
  getPreparationTasks,
  createPreparationTask,
  updatePreparationTask,
  deletePreparationTask,
} from "../controllers/preparation-task.controller";

const router = Router({ mergeParams: true });

router.use(authenticate);

router.get("/", getPreparationTasks);
router.post("/", createPreparationTask);
router.patch("/:taskId", updatePreparationTask);
router.delete("/:taskId", deletePreparationTask);

export default router;
