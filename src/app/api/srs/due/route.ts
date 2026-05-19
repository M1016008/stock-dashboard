import { NextRequest } from "next/server";
import { listDueCards } from "@/lib/srs";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(200, Number(limitParam))) : 50;
  const cards = await listDueCards(limit);
  return Response.json({ cards });
}
