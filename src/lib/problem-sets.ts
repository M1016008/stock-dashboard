import { randomUUID } from "node:crypto";
import { initDb } from "@/lib/db";
import type {
  ExtractedProblem,
  ExtractedProblemSet,
} from "@/lib/ai/problem-extract";
import type { ProblemAugmentation } from "@/lib/ai/problem-augment";

export interface ProblemSetSummary {
  id: string;
  title: string;
  materialId: string | null;
  materialTitle: string | null;
  problemCount: number;
  augmentedCount: number;
  createdAt: number;
}

export interface ProblemRecord {
  id: string;
  problemIndex: number;
  numberLabel: string | null;
  questionText: string;
  choices: string[] | null;
  answerText: string | null;
  originalExplanation: string | null;
  augmentation: ProblemAugmentation | null;
  augmentedAt: number | null;
}

export interface ProblemSetDetail {
  id: string;
  title: string;
  materialId: string | null;
  materialTitle: string | null;
  createdAt: number;
  problems: ProblemRecord[];
}

export async function listProblemSets(): Promise<ProblemSetSummary[]> {
  const db = await initDb();
  const res = await db.execute(`
    SELECT
      ps.id, ps.title, ps.material_id, ps.created_at,
      m.title AS material_title,
      (SELECT COUNT(*) FROM problems WHERE problem_set_id = ps.id) AS problem_count,
      (SELECT COUNT(*) FROM problems WHERE problem_set_id = ps.id AND augmented_json IS NOT NULL) AS augmented_count
    FROM problem_sets ps
    LEFT JOIN materials m ON m.id = ps.material_id
    ORDER BY ps.created_at DESC
  `);
  return res.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    materialId: (r.material_id as string | null) ?? null,
    materialTitle: (r.material_title as string | null) ?? null,
    problemCount: Number(r.problem_count),
    augmentedCount: Number(r.augmented_count),
    createdAt: Number(r.created_at),
  }));
}

export async function createProblemSet(input: {
  title: string;
  materialId: string | null;
  sourceText: string;
  extracted: ExtractedProblemSet;
}): Promise<{ id: string }> {
  const db = await initDb();
  const id = randomUUID();
  const createdAt = Date.now();
  const title = input.title.trim() || input.extracted.title.trim() || "問題集";

  const stmts = [
    {
      sql: `INSERT INTO problem_sets (id, title, material_id, source_text, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, title, input.materialId, input.sourceText, createdAt],
    },
  ];
  input.extracted.problems.forEach((p: ExtractedProblem, i: number) => {
    stmts.push({
      sql: `INSERT INTO problems
              (id, problem_set_id, problem_index, number_label, question_text, choices_json, answer_text, original_explanation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        id,
        i,
        p.numberLabel || null,
        p.questionText,
        p.choices ? JSON.stringify(p.choices) : null,
        p.answerText,
        p.originalExplanation || null,
      ],
    });
  });

  await db.batch(stmts, "write");
  return { id };
}

export async function getProblemSet(
  id: string,
): Promise<ProblemSetDetail | null> {
  const db = await initDb();
  const setRes = await db.execute({
    sql: `SELECT ps.id, ps.title, ps.material_id, ps.created_at, m.title AS material_title
          FROM problem_sets ps
          LEFT JOIN materials m ON m.id = ps.material_id
          WHERE ps.id = ?`,
    args: [id],
  });
  const row = setRes.rows[0];
  if (!row) return null;

  const problemsRes = await db.execute({
    sql: `SELECT id, problem_index, number_label, question_text, choices_json,
                 answer_text, original_explanation, augmented_json, augmented_at
          FROM problems WHERE problem_set_id = ? ORDER BY problem_index ASC`,
    args: [id],
  });

  return {
    id: row.id as string,
    title: row.title as string,
    materialId: (row.material_id as string | null) ?? null,
    materialTitle: (row.material_title as string | null) ?? null,
    createdAt: Number(row.created_at),
    problems: problemsRes.rows.map((r) => ({
      id: r.id as string,
      problemIndex: Number(r.problem_index),
      numberLabel: (r.number_label as string | null) ?? null,
      questionText: r.question_text as string,
      choices: r.choices_json
        ? (JSON.parse(r.choices_json as string) as string[])
        : null,
      answerText: (r.answer_text as string | null) ?? null,
      originalExplanation: (r.original_explanation as string | null) ?? null,
      augmentation: r.augmented_json
        ? (JSON.parse(r.augmented_json as string) as ProblemAugmentation)
        : null,
      augmentedAt: r.augmented_at ? Number(r.augmented_at) : null,
    })),
  };
}

export async function deleteProblemSet(id: string): Promise<boolean> {
  const db = await initDb();
  const res = await db.execute({
    sql: "DELETE FROM problem_sets WHERE id = ?",
    args: [id],
  });
  return res.rowsAffected > 0;
}

export async function saveAugmentation(
  problemId: string,
  augmentation: ProblemAugmentation,
): Promise<void> {
  const db = await initDb();
  await db.execute({
    sql: `UPDATE problems
          SET augmented_json = ?, augmented_at = ?
          WHERE id = ?`,
    args: [JSON.stringify(augmentation), Date.now(), problemId],
  });
}

export async function getProblemForAugment(
  problemSetId: string,
  problemIndex: number,
): Promise<{
  problemId: string;
  questionText: string;
  choices: string[] | null;
  answerText: string | null;
  originalExplanation: string;
  materialText: string | null;
} | null> {
  const db = await initDb();
  const res = await db.execute({
    sql: `SELECT p.id AS problem_id, p.question_text, p.choices_json,
                 p.answer_text, p.original_explanation,
                 m.original_text AS material_text
          FROM problems p
          JOIN problem_sets ps ON ps.id = p.problem_set_id
          LEFT JOIN materials m ON m.id = ps.material_id
          WHERE p.problem_set_id = ? AND p.problem_index = ?`,
    args: [problemSetId, problemIndex],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    problemId: row.problem_id as string,
    questionText: row.question_text as string,
    choices: row.choices_json
      ? (JSON.parse(row.choices_json as string) as string[])
      : null,
    answerText: (row.answer_text as string | null) ?? null,
    originalExplanation: (row.original_explanation as string | null) ?? "",
    materialText: (row.material_text as string | null) ?? null,
  };
}
