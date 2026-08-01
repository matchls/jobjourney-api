import { Prisma, PrismaClient } from "@prisma/client";
import { applicationMatchesDedupKey } from "../utils/agent-dedup";

type QueryClient = PrismaClient | Prisma.TransactionClient;

// Scans every application owned by the user (MANUAL and AGENT_IMPORT alike,
// regardless of whether their agentDedupKey column was ever populated) and
// recomputes each one's fingerprint on the fly, so a duplicate is caught no
// matter when or how the existing row was created. O(n) in the user's
// application count — acceptable for a personal job tracker's volumes;
// revisit with a generated/indexed column if that ever stops being true.
export const findApplicationMatchingDedupKey = async (
  client: QueryClient,
  userId: string,
  dedupKey: string,
  excludeApplicationId?: string,
) => {
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
    applicationMatchesDedupKey(application, dedupKey),
  );
};
