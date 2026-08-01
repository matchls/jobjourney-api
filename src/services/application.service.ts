import prisma from "../config/prisma";
import {
  CreateApplicationInput,
  UpdateApplicationInput,
} from "../validators/application.validator";

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

  const statusChanged =
    rest.status !== undefined && rest.status !== application.status;

  if (!statusChanged) {
    return prisma.application.update({
      where: { id },
      data: { ...rest, ...reviewUpdate },
    });
  }

  const [updated] = await prisma.$transaction([
    prisma.application.update({
      where: { id },
      data: { ...rest, ...reviewUpdate, statusChangedAt: new Date() },
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
};

export const deleteApplication = async (id: string, userId: string) => {
  const application = await prisma.application.findUnique({ where: { id } });

  if (!application || application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.application.delete({ where: { id } });
};
