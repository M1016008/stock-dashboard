import { NextRequest } from "next/server";
import { getHistoryReport } from "@/lib/history";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const tzParam = req.nextUrl.searchParams.get("tzOffset");
  const tzOffsetMin = tzParam !== null ? Number(tzParam) : 0;
  const safeTz =
    Number.isFinite(tzOffsetMin) && Math.abs(tzOffsetMin) <= 24 * 60
      ? Math.floor(tzOffsetMin)
      : 0;

  try {
    const report = await getHistoryReport(safeTz);
    return Response.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
