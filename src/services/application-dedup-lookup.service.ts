import { Prisma, PrismaClient } from "@prisma/client";
import {
  AgentDedupInput,
  applicationMatchesDedupSignals,
  computeAgentDedupSignals,
} from "../utils/agent-dedup";

type QueryClient = PrismaClient | Prisma.TransactionClient;

// Scans every application owned by the user (MANUAL and AGENT_IMPORT alike,
// regardless of whether their agentDedupKey column was ever populated) and
// recomputes each one's fingerprint on the fly, so a duplicate is caught no
// matter when or how the existing row was created. O(n) in the user's
// application count — acceptable for a personal job tracker's volumes;
// revisit with a generated/indexed column if that ever stops being true.
//
// Takes the candidate's raw fields (not a single precomputed dedup key) so
// it can apply the mixed URL/fallback rule: both the URL and fallback
// signals are computed once for the candidate, then compared against both
// signals of every existing application (see applicationMatchesDedupSignals).
export const findApplicationMatchingDedupKey = async (
  client: QueryClient,
  userId: string,
  candidate: AgentDedupInput,
  excludeApplicationId?: string,
) => {
  const candidateSignals = computeAgentDedupSignals(candidate);

  const applications = await client.application.findMany({
    where: {
      userId,
      ...(excludeApplicationId ? { id: { not: excludeApplicationId } } : {}),
    },
    select: {
      id: true,
      offerUrl: true,
      company: true,
      position: true,
      location: true,
    },
  });

  return applications.find((application) =>
    applicationMatchesDedupSignals(application, candidateSignals),
  );
};
