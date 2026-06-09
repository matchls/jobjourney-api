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
      interviewSteps: { orderBy: { order: "asc" } },
      preparationTasks: { orderBy: { order: "asc" } },
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
    data: { ...data, userId },
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

  return prisma.application.update({
    where: { id },
    data,
  });
};

export const deleteApplication = async (id: string, userId: string) => {
  const application = await prisma.application.findUnique({ where: { id } });

  if (!application || application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.application.delete({ where: { id } });
};
