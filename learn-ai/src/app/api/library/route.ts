import { NextRequest } from "next/server";
import { listMaterials, saveMaterial } from "@/lib/library";

export const runtime = "nodejs";

export async function GET() {
  const items = await listMaterials();
  return Response.json({ items });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON body が不正です" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title : "";
  const originalText =
    typeof body.originalText === "string" ? body.originalText : "";
  const structure = body.structure as
    | { title: string; nodes: unknown[] }
    | undefined;

  if (!originalText.trim()) {
    return Response.json({ error: "originalText が空です" }, { status: 400 });
  }
  if (!structure || !Array.isArray(structure.nodes)) {
    return Response.json({ error: "structure が不正です" }, { status: 400 });
  }

  const material = await saveMaterial({
    title: title || structure.title || "(無題)",
    originalText,
    structure: structure as never,
  });
  return Response.json({ material });
}
