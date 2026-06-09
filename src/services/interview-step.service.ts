import prisma from "../config/prisma";
import {
  CreateInterviewStepInput,
  UpdateInterviewStepInput,
} from "../validators/interview-step.validator";

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

export const getInterviewSteps = async (
  applicationId: string,
  userId: string,
) => {
  await verifyApplicationOwnership(applicationId, userId);

  return prisma.interviewStep.findMany({
    where: { applicationId },
    orderBy: { order: "asc" },
  });
};

export const createInterviewStep = async (
  applicationId: string,
  userId: string,
  data: CreateInterviewStepInput,
) => {
  await verifyApplicationOwnership(applicationId, userId);

  return prisma.interviewStep.create({
    data: { ...data, applicationId },
  });
};

export const updateInterviewStep = async (
  stepId: string,
  userId: string,
  data: UpdateInterviewStepInput,
) => {
  const step = await prisma.interviewStep.findUnique({
    where: { id: stepId },
    include: { application: true },
  });

  if (!step || step.application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.interviewStep.update({
    where: { id: stepId },
    data,
  });
};

export const deleteInterviewStep = async (stepId: string, userId: string) => {
  const step = await prisma.interviewStep.findUnique({
    where: { id: stepId },
    include: { application: true },
  });

  if (!step || step.application.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.interviewStep.delete({ where: { id: stepId } });
};
