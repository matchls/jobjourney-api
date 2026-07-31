import prisma from "../config/prisma";
import {
  CreateInterviewStepInput,
  UpdateInterviewStepInput,
} from "../validators/interview-step.validator";
import { verifySkillOwnership } from "./skill.service";

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
    include: { skills: true },
  });
};

export const createInterviewStep = async (
  applicationId: string,
  userId: string,
  data: CreateInterviewStepInput,
) => {
  await verifyApplicationOwnership(applicationId, userId);

  const { skillIds, ...rest } = data;

  if (skillIds) {
    await verifySkillOwnership(skillIds, userId);
  }

  return prisma.interviewStep.create({
    data: {
      ...rest,
      applicationId,
      ...(skillIds ? { skills: { connect: skillIds.map((id) => ({ id })) } } : {}),
    },
    include: { skills: true },
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

  const { skillIds, ...rest } = data;

  if (skillIds) {
    await verifySkillOwnership(skillIds, userId);
  }

  let completedAt: Date | string | null | undefined = rest.completedAt;

  if (completedAt === undefined && rest.status !== undefined) {
    if (rest.status === "COMPLETED" && step.status !== "COMPLETED") {
      completedAt = new Date();
    } else if (rest.status !== "COMPLETED" && step.status === "COMPLETED") {
      completedAt = null;
    }
  }

  return prisma.interviewStep.update({
    where: { id: stepId },
    data: {
      ...rest,
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(skillIds ? { skills: { set: skillIds.map((id) => ({ id })) } } : {}),
    },
    include: { skills: true },
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
