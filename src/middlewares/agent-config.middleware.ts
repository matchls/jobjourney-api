import { Request, Response, NextFunction } from "express";

// Must be the very first thing that runs on any /agent/* request — before
// JSON body parsing, before the Bearer header is even looked at, before any
// Prisma lookup. A missing pepper is a server misconfiguration, not a fact
// about this particular request, so the response must be identical no
// matter what the caller sent (no header, a malformed key, an unknown or a
// real prefix all get the same 503).
export const requireAgentConfig = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!process.env.AGENT_API_KEY_PEPPER) {
    res.status(503).json({ error: { code: "agent_config_error" } });
    return;
  }
  next();
};
