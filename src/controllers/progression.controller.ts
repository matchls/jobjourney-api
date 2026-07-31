import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { getProgressionData } from "../services/progression.service";

export const getProgression = async (req: AuthRequest, res: Response) => {
  try {
    const data = await getProgressionData(req.userId!);
    res.status(200).json(data);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
};
