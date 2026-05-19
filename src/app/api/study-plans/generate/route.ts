import { generateStudyPlan } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.projectId !== "string" || !body.projectId) {
    return Response.json(
      { error: "projectId が必要です。" },
      { status: 400 },
    );
  }

  try {
    const plan = await generateStudyPlan({
      projectId: body.projectId,
      targetCompletionDate:
        typeof body.targetCompletionDate === "string"
          ? body.targetCompletionDate
          : "",
      studyStyle: typeof body.studyStyle === "string" ? body.studyStyle : "exam",
      weekdayMinutes:
        typeof body.weekdayMinutes === "object" && body.weekdayMinutes
          ? body.weekdayMinutes
          : defaultWeekdayMinutes(),
      includeQuiz: body.includeQuiz !== false,
      includeReviewDays: body.includeReviewDays !== false,
      includeAudioLearning: body.includeAudioLearning !== false,
    });
    return Response.json({ plan });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

function defaultWeekdayMinutes() {
  return {
    "0": 45,
    "1": 30,
    "2": 30,
    "3": 30,
    "4": 30,
    "5": 45,
    "6": 60,
  };
}
