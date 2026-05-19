import { randomUUID } from "node:crypto";
import { initDb } from "@/lib/db";
import type {
  Difficulty,
  QuestionType,
  QuizQuestion,
  SavedQuizResult,
} from "@/lib/ai/quiz";

export type Rating = "again" | "hard" | "good" | "easy";

export interface SrsCardState {
  questionId: string;
  ease: number;
  intervalDays: number;
  repetitions: number;
  dueAt: number;
  lastReviewedAt: number | null;
  lastRating: Rating | null;
}

export interface DueCard {
  question: {
    id: string;
    type: QuestionType;
    question: string;
    choices: string[] | null;
    answer: number;
    explanation: string;
  };
  source: {
    materialId: string | null;
    materialTitle: string | null;
    nodeTitle: string | null;
    difficulty: Difficulty;
    sessionType: QuestionType;
  };
  card: SrsCardState | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AGAIN_INTERVAL_DAYS = 10 / (60 * 24); // 10 minutes

export interface SaveQuizInput {
  materialId: string | null;
  materialTitle: string | null;
  nodeKey: string | null;
  nodeTitle: string | null;
  type: QuestionType;
  difficulty: Difficulty;
  questions: QuizQuestion[];
}

export async function saveQuizSession(
  input: SaveQuizInput,
): Promise<SavedQuizResult> {
  const db = await initDb();
  const sessionId = randomUUID();
  const createdAt = Date.now();
  const sourceLabel = [input.materialTitle, input.nodeTitle]
    .filter(Boolean)
    .join(" > ");

  const stmts = [
    {
      sql: `INSERT INTO quiz_sessions
        (id, material_id, node_key, node_title, source_label, type, difficulty, question_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        sessionId,
        input.materialId,
        input.nodeKey,
        input.nodeTitle,
        sourceLabel || null,
        input.type,
        input.difficulty,
        input.questions.length,
        createdAt,
      ],
    },
  ];

  const saved: SavedQuizResult = { sessionId, questions: [] };
  input.questions.forEach((q, i) => {
    const id = randomUUID();
    stmts.push({
      sql: `INSERT INTO quiz_questions
        (id, session_id, question_index, type, question, choices_json, answer, explanation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        sessionId,
        i,
        q.type,
        q.question,
        q.choices ? JSON.stringify(q.choices) : null,
        q.answer,
        q.explanation,
      ],
    });
    saved.questions.push({ ...q, id });
  });

  await db.batch(stmts, "write");
  return saved;
}

export function reviewCard(
  prev: SrsCardState | null,
  rating: Rating,
  now: number = Date.now(),
): SrsCardState {
  const quality = { again: 0, hard: 3, good: 4, easy: 5 }[rating];
  let ease = prev?.ease ?? 2.5;
  let intervalDays = prev?.intervalDays ?? 0;
  let repetitions = prev?.repetitions ?? 0;

  if (quality < 3) {
    repetitions = 0;
    intervalDays = AGAIN_INTERVAL_DAYS;
  } else {
    repetitions += 1;
    if (repetitions === 1) {
      intervalDays = quality === 5 ? 4 : 1;
    } else if (repetitions === 2) {
      intervalDays = quality === 5 ? 7 : 4;
    } else {
      const factor = quality === 5 ? 1.3 : quality === 3 ? 0.8 : 1.0;
      intervalDays = intervalDays * ease * factor;
    }
  }

  ease = ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ease < 1.3) ease = 1.3;

  return {
    questionId: prev?.questionId ?? "",
    ease,
    intervalDays,
    repetitions,
    dueAt: now + intervalDays * MS_PER_DAY,
    lastReviewedAt: now,
    lastRating: rating,
  };
}

export async function getCard(
  questionId: string,
): Promise<SrsCardState | null> {
  const db = await initDb();
  const res = await db.execute({
    sql: `SELECT question_id, ease, interval_days, repetitions, due_at, last_reviewed_at, last_rating
          FROM srs_cards WHERE question_id = ?`,
    args: [questionId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    questionId: row.question_id as string,
    ease: row.ease as number,
    intervalDays: row.interval_days as number,
    repetitions: Number(row.repetitions),
    dueAt: Number(row.due_at),
    lastReviewedAt: row.last_reviewed_at ? Number(row.last_reviewed_at) : null,
    lastRating: (row.last_rating as Rating | null) ?? null,
  };
}

export async function recordAnswer(input: {
  questionId: string;
  selectedIndex: number;
  rating: Rating;
}): Promise<{ isCorrect: boolean; card: SrsCardState }> {
  const db = await initDb();

  const q = await db.execute({
    sql: "SELECT answer FROM quiz_questions WHERE id = ?",
    args: [input.questionId],
  });
  if (q.rows.length === 0) {
    throw new Error("問題が見つかりません");
  }
  const correctAnswer = Number(q.rows[0].answer);
  const isCorrect = correctAnswer === input.selectedIndex;
  const answeredAt = Date.now();

  const prev = await getCard(input.questionId);
  const next = reviewCard(prev, input.rating, answeredAt);
  next.questionId = input.questionId;

  await db.batch(
    [
      {
        sql: `INSERT INTO answers (question_id, selected_index, is_correct, answered_at)
              VALUES (?, ?, ?, ?)`,
        args: [
          input.questionId,
          input.selectedIndex,
          isCorrect ? 1 : 0,
          answeredAt,
        ],
      },
      {
        sql: `INSERT INTO srs_cards
              (question_id, ease, interval_days, repetitions, due_at, last_reviewed_at, last_rating)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(question_id) DO UPDATE SET
                ease = excluded.ease,
                interval_days = excluded.interval_days,
                repetitions = excluded.repetitions,
                due_at = excluded.due_at,
                last_reviewed_at = excluded.last_reviewed_at,
                last_rating = excluded.last_rating`,
        args: [
          input.questionId,
          next.ease,
          next.intervalDays,
          next.repetitions,
          next.dueAt,
          next.lastReviewedAt,
          next.lastRating,
        ],
      },
    ],
    "write",
  );

  return { isCorrect, card: next };
}

export async function listDueCards(
  limit: number = 50,
  now: number = Date.now(),
): Promise<DueCard[]> {
  const db = await initDb();
  const res = await db.execute({
    sql: `SELECT
            q.id AS question_id,
            q.type AS q_type,
            q.question AS question_text,
            q.choices_json AS choices_json,
            q.answer AS answer,
            q.explanation AS explanation,
            s.material_id AS material_id,
            s.node_title AS node_title,
            s.difficulty AS difficulty,
            s.type AS s_type,
            m.title AS material_title,
            c.ease AS ease,
            c.interval_days AS interval_days,
            c.repetitions AS repetitions,
            c.due_at AS due_at,
            c.last_reviewed_at AS last_reviewed_at,
            c.last_rating AS last_rating
          FROM srs_cards c
          JOIN quiz_questions q ON q.id = c.question_id
          JOIN quiz_sessions s ON s.id = q.session_id
          LEFT JOIN materials m ON m.id = s.material_id
          WHERE c.due_at <= ?
          ORDER BY c.due_at ASC
          LIMIT ?`,
    args: [now, limit],
  });

  return res.rows.map((row) => ({
    question: {
      id: row.question_id as string,
      type: row.q_type as QuestionType,
      question: row.question_text as string,
      choices: row.choices_json
        ? (JSON.parse(row.choices_json as string) as string[])
        : null,
      answer: Number(row.answer),
      explanation: row.explanation as string,
    },
    source: {
      materialId: (row.material_id as string | null) ?? null,
      materialTitle: (row.material_title as string | null) ?? null,
      nodeTitle: (row.node_title as string | null) ?? null,
      difficulty: row.difficulty as Difficulty,
      sessionType: row.s_type as QuestionType,
    },
    card: {
      questionId: row.question_id as string,
      ease: row.ease as number,
      intervalDays: row.interval_days as number,
      repetitions: Number(row.repetitions),
      dueAt: Number(row.due_at),
      lastReviewedAt: row.last_reviewed_at
        ? Number(row.last_reviewed_at)
        : null,
      lastRating: (row.last_rating as Rating | null) ?? null,
    },
  }));
}

export interface SrsStats {
  dueNow: number;
  dueToday: number;
  totalCards: number;
  reviewedToday: number;
  correctToday: number;
}

export async function getStats(now: number = Date.now()): Promise<SrsStats> {
  const db = await initDb();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = startOfDay.getTime() + MS_PER_DAY;

  const [dueNowRes, dueTodayRes, totalRes, todayRes] = await Promise.all([
    db.execute({
      sql: "SELECT COUNT(*) AS n FROM srs_cards WHERE due_at <= ?",
      args: [now],
    }),
    db.execute({
      sql: "SELECT COUNT(*) AS n FROM srs_cards WHERE due_at <= ?",
      args: [endOfDay],
    }),
    db.execute({ sql: "SELECT COUNT(*) AS n FROM srs_cards", args: [] }),
    db.execute({
      sql: `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
            FROM answers WHERE answered_at >= ?`,
      args: [startOfDay.getTime()],
    }),
  ]);

  return {
    dueNow: Number(dueNowRes.rows[0].n),
    dueToday: Number(dueTodayRes.rows[0].n),
    totalCards: Number(totalRes.rows[0].n),
    reviewedToday: Number(todayRes.rows[0].total),
    correctToday: Number(todayRes.rows[0].correct),
  };
}
