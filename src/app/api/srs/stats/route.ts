import { getStats } from "@/lib/srs";

export const runtime = "nodejs";

export async function GET() {
  const stats = await getStats();
  return Response.json(stats);
}
