import { NextRequest } from "next/server";
import { recordAnswer, type Rating } from "@/lib/srs";

export const runtime = "nodejs";

const VALID_RATINGS = new Set<Rating>(["again", "hard", "good", "easy"]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON body が不正です" }, { status: 400 });
  }

  const questionId =
    typeof body.questionId === "string" ? body.questionId : "";
  if (!questionId) {
    return Response.json({ error: "questionId が必要です" }, { status: 400 });
  }

  const selectedIndex = Number(body.selectedIndex);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) {
    return Response.json(
      { error: "selectedIndex が不正です" },
      { status: 400 },
    );
  }

  const rating = body.rating as Rating;
  if (!VALID_RATINGS.has(rating)) {
    return Response.json({ error: "rating が不正です" }, { status: 400 });
  }

  try {
    const result = await recordAnswer({ questionId, selectedIndex, rating });
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
