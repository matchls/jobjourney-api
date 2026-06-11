import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { getDashboardData } from "../services/dashboard.service";

export const getDashboard = async (req: AuthRequest, res: Response) => {
  try {
    const data = await getDashboardData(req.userId!);
    res.status(200).json(data);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
};
