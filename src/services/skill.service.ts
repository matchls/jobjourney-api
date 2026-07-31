import prisma from "../config/prisma";
import { CreateSkillInput, UpdateSkillInput } from "../validators/skill.validator";

export const getSkills = async (userId: string) => {
  return prisma.skill.findMany({
    where: { userId },
    orderBy: { name: "asc" },
  });
};

export const createSkill = async (userId: string, data: CreateSkillInput) => {
  return prisma.skill.create({
    data: { ...data, userId },
  });
};

export const updateSkill = async (
  id: string,
  userId: string,
  data: UpdateSkillInput,
) => {
  const skill = await prisma.skill.findUnique({ where: { id } });

  if (!skill || skill.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.skill.update({ where: { id }, data });
};

export const deleteSkill = async (id: string, userId: string) => {
  const skill = await prisma.skill.findUnique({ where: { id } });

  if (!skill || skill.userId !== userId) {
    throw new Error("NOT_FOUND");
  }

  return prisma.skill.delete({ where: { id } });
};

export const verifySkillOwnership = async (
  skillIds: string[],
  userId: string,
) => {
  const uniqueIds = Array.from(new Set(skillIds));

  if (uniqueIds.length === 0) {
    return;
  }

  const count = await prisma.skill.count({
    where: { id: { in: uniqueIds }, userId },
  });

  if (count !== uniqueIds.length) {
    throw new Error("INVALID_SKILLS");
  }
};
