import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { corsOrigin } from "./config/cors.config";
import authRoutes from "./routes/auth.routes";
import applicationRoutes from "./routes/application.routes";
import interviewStepRoutes from "./routes/interview-step.routes";
import preparationTaskRoutes from "./routes/preparation-task.routes";
import userRoutes from "./routes/user.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import skillRoutes from "./routes/skill.routes";
import progressionRoutes from "./routes/progression.routes";
import agentRoutes from "./routes/agent.routes";
import { requireAgentConfig } from "./middlewares/agent-config.middleware";

const app = express();

// L'origine autorisée n'est plus une chaîne figée mais un délégué : il faut
// accepter, en plus de CLIENT_URL, les previews Vercel d'un projet et d'une
// team explicitement déclarés. Toute la règle vit dans cors.config.ts.
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }) as unknown as express.RequestHandler,
);

// requireAgentConfig runs before anything else on /agent/* — before JSON
// parsing, before the Bearer header is read, before any Prisma lookup — so a
// missing AGENT_API_KEY_PEPPER always yields the exact same 503 regardless
// of what the request looks like.
app.use("/agent", requireAgentConfig);

// Scoped separately from the global express.json() below so this route gets
// its own tight 32kb body limit without changing the limit for every other
// route. body-parser skips re-parsing a body it already parsed, so mounting
// this first means the global parser below becomes a no-op for /agent/*.
app.use("/agent", express.json({ limit: "32kb" }), agentRoutes);
app.use(
  "/agent",
  (
    err: { type?: string; status?: number },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      res.status(413).json({ error: { code: "payload_too_large" } });
      return;
    }
    if (err instanceof SyntaxError && err?.type === "entity.parse.failed") {
      res.status(400).json({
        error: { code: "invalid_json", fieldErrors: {}, formErrors: ["JSON invalide"] },
      });
      return;
    }
    next(err);
  },
);

// Le texte d'offre collé est le seul body volumineux attendu de l'app web.
// Parseur dédié, monté avant le parseur global (que body-parser rendra alors
// no-op pour ce chemin), pour lui donner sa propre limite sans desserrer
// celle de toutes les autres routes. 256kb couvre confortablement les 20 000
// caractères autorisés pour offerText, même en UTF-8 dense.
app.use("/applications/parse-offer", express.json({ limit: "256kb" }));
app.use(
  "/applications/parse-offer",
  (
    err: { type?: string; status?: number },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      res.status(413).json({ error: { code: "payload_too_large" } });
      return;
    }
    if (err instanceof SyntaxError && err?.type === "entity.parse.failed") {
      res.status(400).json({
        error: { code: "invalid_json", fieldErrors: {}, formErrors: ["JSON invalide"] },
      });
      return;
    }
    next(err);
  },
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
