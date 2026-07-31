import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.routes";
import applicationRoutes from "./routes/application.routes";
import interviewStepRoutes from "./routes/interview-step.routes";
import preparationTaskRoutes from "./routes/preparation-task.routes";
import userRoutes from "./routes/user.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import skillRoutes from "./routes/skill.routes";
import progressionRoutes from "./routes/progression.routes";

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }) as unknown as express.RequestHandler,
);
app.use(express.json());
app.use(cookieParser());
app.use("/auth", authRoutes);
app.use("/applications", applicationRoutes);
app.use("/applications/:id/interview-steps", interviewStepRoutes);
app.use("/applications/:id/preparation-tasks", preparationTaskRoutes);
app.use("/users", userRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/skills", skillRoutes);
app.use("/progression", progressionRoutes);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err.stack);
    res.status(500).json({ error: "Internal server error" });
  },
);

export default app;
