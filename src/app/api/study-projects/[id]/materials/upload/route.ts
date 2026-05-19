import { addMaterialsToProject, MAX_UPLOAD_BYTES } from "@/lib/study-projects";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();
  const files = form
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (files.length === 0) {
    return Response.json(
      { error: "アップロードする教材ファイルを選択してください。" },
      { status: 400 },
    );
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: "1回のアップロードは合計100MBまでです。" },
      { status: 413 },
    );
  }

  try {
    const materials = await addMaterialsToProject(id, files);
    return Response.json({ materials });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
