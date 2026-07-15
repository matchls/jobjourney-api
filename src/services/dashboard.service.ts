import prisma from "../config/prisma";

export const getDashboardData = async (userId: string) => {
  const [grouped, upcomingInterviews, completedInterviewSteps] =
    await Promise.all([
      prisma.application.groupBy({
        by: ["status"],
        where: { userId },
        _count: { _all: true },
      }),
      prisma.interviewStep.findMany({
        where: {
          application: { userId },
          scheduledAt: { gte: new Date() },
          status: "PLANNED",
        },
        orderBy: { scheduledAt: "asc" },
        take: 5,
        include: {
          application: {
            select: { id: true, company: true, position: true },
          },
        },
      }),
      prisma.interviewStep.findMany({
        where: { application: { userId }, status: "COMPLETED" },
        select: { application: { select: { company: true } } },
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

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const completedInterviewsByCompany: Record<string, number> = {};
  for (const step of completedInterviewSteps) {
    const company = step.application.company;
    completedInterviewsByCompany[company] =
      (completedInterviewsByCompany[company] ?? 0) + 1;
  }

  return {
    stats: { total, byStatus },
    upcomingInterviews,
    completedInterviews: {
      total: completedInterviewSteps.length,
      byCompany: completedInterviewsByCompany,
    },
  };
};
