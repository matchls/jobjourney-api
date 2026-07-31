import prisma from "../config/prisma";

const MONTHS_HISTORY = 6;

const monthKey = (date: Date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const buildLastMonths = (count: number) => {
  const now = new Date();
  const months: { key: string; start: Date }[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    months.push({ key: monthKey(start), start });
  }

  return months;
};

export const getProgressionData = async (userId: string) => {
  const months = buildLastMonths(MONTHS_HISTORY);
  const historyStart = months[0].start;

  const [
    grouped,
    completedInterviewsCount,
    applicationsForHistory,
    completedStepsForHistory,
    skills,
  ] = await Promise.all([
    prisma.application.groupBy({
      by: ["status"],
      where: { userId },
      _count: { _all: true },
    }),
    prisma.interviewStep.count({
      where: { application: { userId }, status: "COMPLETED" },
    }),
    prisma.application.findMany({
      where: { userId, createdAt: { gte: historyStart } },
      select: { createdAt: true },
    }),
    prisma.interviewStep.findMany({
      where: {
        application: { userId },
        status: "COMPLETED",
        completedAt: { gte: historyStart },
      },
      select: { completedAt: true },
    }),
    prisma.skill.findMany({
      where: { userId },
      include: {
        _count: { select: { interviewSteps: true, preparationTasks: true } },
      },
    }),
  ]);

  const byStatus = {
    TARGETED: 0,
    APPLIED: 0,
    INTERVIEWING: 0,
    OFFER: 0,
    REJECTED: 0,
  };

  for (const group of grouped) {
    byStatus[group.status] = group._count._all;
  }

  const totalApplications = Object.values(byStatus).reduce(
    (a, b) => a + b,
    0,
  );
  const submittedApplications = totalApplications - byStatus.TARGETED;

  // offerRate = candidatures avec offre / candidatures soumises (hors TARGETED) * 100, arrondi à l'entier le plus proche. 0 si aucune candidature soumise.
  const offerRate =
    submittedApplications > 0
      ? Math.round((byStatus.OFFER / submittedApplications) * 100)
      : 0;

  const applicationsByMonth = new Map<string, number>();
  for (const application of applicationsForHistory) {
    const key = monthKey(application.createdAt);
    applicationsByMonth.set(key, (applicationsByMonth.get(key) ?? 0) + 1);
  }

  const interviewsByMonth = new Map<string, number>();
  for (const step of completedStepsForHistory) {
    if (!step.completedAt) continue;
    const key = monthKey(step.completedAt);
    interviewsByMonth.set(key, (interviewsByMonth.get(key) ?? 0) + 1);
  }

  const activityByMonth = months.map(({ key }) => ({
    month: key,
    applicationsCreated: applicationsByMonth.get(key) ?? 0,
    interviewsCompleted: interviewsByMonth.get(key) ?? 0,
  }));

  const skillsWithUsage = skills
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      interviewStepsCount: skill._count.interviewSteps,
      preparationTasksCount: skill._count.preparationTasks,
      usageCount: skill._count.interviewSteps + skill._count.preparationTasks,
    }))
    .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));

  return {
    stats: {
      totalApplications,
      submittedApplications,
      byStatus,
      offerRate,
      completedInterviews: completedInterviewsCount,
    },
    activityByMonth,
    skills: skillsWithUsage,
  };
};
