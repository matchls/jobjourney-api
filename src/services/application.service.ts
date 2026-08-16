import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import {
  CreateApplicationInput,
  UpdateApplicationInput,
} from "../validators/application.validator";
import { computeAgentDedupKey } from "../utils/agent-dedup";
import { findApplicationMatchingDedupKey } from "./application-dedup-lookup.service";

export class ApplicationDuplicateError extends Error {
  constructor() {
    super("APPLICATION_DUPLICATE");
  }
}

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

export const getApplications = async (userId: string) => {
  return prisma.application.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
};

export const getApplicationById = async (id: string, userId: string) => {
  const application = await prisma.application.findUnique({
    where: { id },
    include: {
      interviewSteps: {
        orderBy: { order: "asc" },
        include: { skills: true },
      },
      preparationTasks: {
        orderBy: { order: "asc" },
        include: { skill: true },
      },
      statusHistory: { orderBy: { changedAt: "asc" } },
    },
  });

  if (!application || application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return application;
};

export const createApplication = async (
  userId: string,
  data: CreateApplicationInput,
) => {
  // Same duplicate rule as POST /agent/applications and PATCH
  // /applications/:id — the shared lookup recomputes each existing
  // application's fingerprint live (see agent-dedup.ts), so this catches a
  // duplicate against MANUAL rows too, whose agentDedupKey is always null.
  //
  // agentDedupKey is deliberately NOT written here: it stays an
  // import-only column, and its @@unique([userId, agentDedupKey])
  // constraint would turn a deliberately replayed application into a
  // permanent DB-level error instead of a rule we can relax later.
  const duplicate = await findApplicationMatchingDedupKey(prisma, userId, {
    offerUrl: data.offerUrl,
    company: data.company,
    position: data.position,
    location: data.location,
  });

  if (duplicate) {
    throw new ApplicationDuplicateError();
  }

  return prisma.application.create({
    data: { ...data, userId, statusChangedAt: new Date() },
  });
};

export const updateApplication = async (
  id: string,
  userId: string,
  data: UpdateApplicationInput,
) => {
  const application = await prisma.application.findUnique({ where: { id } });

  if (!application || application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  // confirmImportReview is a user intent, not a Prisma column — translate it
  // into the two real columns it actually affects, then drop it from the
  // payload so it's never forwarded to Prisma directly.
  const { confirmImportReview, ...rest } = data;

  const reviewUpdate =
    confirmImportReview === true && application.creationSource === "AGENT_IMPORT"
      ? { importReviewStatus: "REVIEWED" as const, reviewedAt: new Date() }
      : {};

  // A user correcting an agent-imported application's identifying fields
  // (offerUrl/company/position/location) should keep it in sync with the
  // same fingerprint the agent-import route uses — otherwise a later import
  // of the corrected URL would silently create a second application instead
  // of being recognized as the same one.
  let dedupUpdate: { agentDedupKey?: string } = {};

  if (application.creationSource === "AGENT_IMPORT") {
    const touchesFingerprintFields =
      rest.offerUrl !== undefined ||
      rest.company !== undefined ||
      rest.position !== undefined ||
      rest.location !== undefined;

    if (touchesFingerprintFields) {
      const mergedFingerprintFields = {
        offerUrl: rest.offerUrl !== undefined ? rest.offerUrl : application.offerUrl ?? undefined,
        company: rest.company !== undefined ? rest.company : application.company,
        position: rest.position !== undefined ? rest.position : application.position,
        location: rest.location !== undefined ? rest.location : application.location ?? undefined,
      };
      const newDedupKey = computeAgentDedupKey(mergedFingerprintFields);

      if (newDedupKey !== application.agentDedupKey) {
        const conflict = await findApplicationMatchingDedupKey(
          prisma,
          userId,
          mergedFingerprintFields,
          id,
        );

        if (conflict) {
          throw new ApplicationDuplicateError();
        }

        dedupUpdate = { agentDedupKey: newDedupKey };
      }
    }
  }

  const statusChanged =
    rest.status !== undefined && rest.status !== application.status;

  try {
    if (!statusChanged) {
      return await prisma.application.update({
        where: { id },
        data: { ...rest, ...reviewUpdate, ...dedupUpdate },
      });
    }

    const [updated] = await prisma.$transaction([
      prisma.application.update({
        where: { id },
        data: { ...rest, ...reviewUpdate, ...dedupUpdate, statusChangedAt: new Date() },
      }),
      prisma.applicationStatusHistory.create({
        data: {
          applicationId: id,
          fromStatus: application.status,
          toStatus: rest.status!,
        },
      }),
    ]);

    return updated;
  } catch (error) {
    // Belt-and-suspenders: a concurrent request could have raced past the
    // pre-check above and inserted the same fingerprint first. The DB's
    // @@unique([userId, agentDedupKey]) constraint is the real guarantee.
    if (dedupUpdate.agentDedupKey && isUniqueConstraintError(error)) {
      throw new ApplicationDuplicateError();
    }
    throw error;
  }
};

export const deleteApplication = async (id: string, userId: string) => {
  const application = await prisma.application.findUnique({ where: { id } });

  if (!application || application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.application.delete({ where: { id } });
};
