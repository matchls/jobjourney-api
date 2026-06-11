import prisma from "../config/prisma";

export const getDashboardData = async (userId: string) => {
  const [grouped, upcomingInterviews] = await Promise.all([
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

  return {
    stats: { total, byStatus },
    upcomingInterviews,
  };
};
