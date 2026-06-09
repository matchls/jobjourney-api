import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.routes";
import applicationRoutes from "./routes/application.routes";
import interviewStepRoutes from "./routes/interview-step.routes";
import preparationTaskRoutes from "./routes/preparation-task.routes";
const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());
app.use("/auth", authRoutes);
app.use("/applications", applicationRoutes);
app.use("/applications/:id/interview-steps", interviewStepRoutes);
app.use("/applications/:id/preparation-tasks", preparationTaskRoutes);
export default app;
