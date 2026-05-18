import { randomUUID } from "node:crypto";
import { initDb } from "@/lib/db";
import type { DocumentStructure } from "@/lib/ai/structure";

export interface MaterialSummary {
  id: string;
  title: string;
  createdAt: number;
}

export interface Material extends MaterialSummary {
  originalText: string;
  structure: DocumentStructure;
}

export async function listMaterials(): Promise<MaterialSummary[]> {
  const db = await initDb();
  const res = await db.execute(
    "SELECT id, title, created_at FROM materials ORDER BY created_at DESC",
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    createdAt: Number(r.created_at),
  }));
}

export async function getMaterial(id: string): Promise<Material | null> {
  const db = await initDb();
  const res = await db.execute({
    sql: "SELECT id, title, original_text, structure_json, created_at FROM materials WHERE id = ?",
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    title: row.title as string,
    originalText: row.original_text as string,
    structure: JSON.parse(row.structure_json as string) as DocumentStructure,
    createdAt: Number(row.created_at),
  };
}

export async function saveMaterial(input: {
  title: string;
  originalText: string;
  structure: DocumentStructure;
}): Promise<Material> {
  const db = await initDb();
  const id = randomUUID();
  const createdAt = Date.now();
  const title = input.title.trim() || "(無題)";
  await db.execute({
    sql: "INSERT INTO materials (id, title, original_text, structure_json, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [id, title, input.originalText, JSON.stringify(input.structure), createdAt],
  });
  return {
    id,
    title,
    originalText: input.originalText,
    structure: input.structure,
    createdAt,
  };
}

export async function deleteMaterial(id: string): Promise<boolean> {
  const db = await initDb();
  const res = await db.execute({
    sql: "DELETE FROM materials WHERE id = ?",
    args: [id],
  });
  return res.rowsAffected > 0;
}
