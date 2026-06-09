import prisma from "../config/prisma";
import {
  CreatePreparationTaskInput,
  UpdatePreparationTaskInput,
} from "../validators/preparation-task.validator";

const verifyApplicationOwnership = async (
  applicationId: string,
  userId: string,
) => {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
  });

  if (!application || application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return application;
};

export const getPreparationTasks = async (
  applicationId: string,
  userId: string,
) => {
  await verifyApplicationOwnership(applicationId, userId);

  return prisma.preparationTask.findMany({
    where: { applicationId },
    orderBy: { order: "asc" },
  });
};

export const createPreparationTask = async (
  applicationId: string,
  userId: string,
  data: CreatePreparationTaskInput,
) => {
  await verifyApplicationOwnership(applicationId, userId);

  return prisma.preparationTask.create({
    data: { ...data, applicationId },
  });
};

export const updatePreparationTask = async (
  taskId: string,
  userId: string,
  data: UpdatePreparationTaskInput,
) => {
  const task = await prisma.preparationTask.findUnique({
    where: { id: taskId },
    include: { application: true },
  });

  if (!task || task.application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.preparationTask.update({
    where: { id: taskId },
    data,
  });
};

export const deletePreparationTask = async (taskId: string, userId: string) => {
  const task = await prisma.preparationTask.findUnique({
    where: { id: taskId },
    include: { application: true },
  });

  if (!task || task.application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.preparationTask.delete({ where: { id: taskId } });
};
