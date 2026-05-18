import { initDb } from "@/lib/db";
import type { Difficulty, QuestionType } from "@/lib/ai/quiz";

export interface HistoryOverview {
  totalAnswers: number;
  correctAnswers: number;
  accuracy: number;
  studyDays: number;
  currentStreak: number;
  longestStreak: number;
}

export interface MaterialStat {
  materialId: string | null;
  materialTitle: string | null;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface NodeStat {
  materialId: string | null;
  materialTitle: string | null;
  nodeKey: string | null;
  nodeTitle: string;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface DailyStat {
  day: string; // YYYY-MM-DD (in user's TZ)
  answered: number;
  correct: number;
}

export interface SessionStat {
  sessionId: string;
  materialId: string | null;
  materialTitle: string | null;
  nodeTitle: string | null;
  type: QuestionType;
  difficulty: Difficulty;
  questionCount: number;
  createdAt: number;
  answered: number;
  correct: number;
}

export interface TypeStat {
  type: QuestionType;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface DifficultyStat {
  difficulty: Difficulty;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface HistoryReport {
  overview: HistoryOverview;
  byMaterial: MaterialStat[];
  weakestNodes: NodeStat[];
  trend: DailyStat[];
  recentSessions: SessionStat[];
  byType: TypeStat[];
  byDifficulty: DifficultyStat[];
  generatedAt: number;
  tzOffsetMin: number;
}

function safeAccuracy(correct: number, answered: number): number {
  return answered > 0 ? correct / answered : 0;
}

function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function toDayString(timestampMs: number, tzOffsetMin: number): string {
  return new Date(timestampMs + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

function computeStreaks(
  days: Set<string>,
  todayStr: string,
): { current: number; longest: number } {
  if (days.size === 0) return { current: 0, longest: 0 };

  // longest run of consecutive days
  const sorted = [...days].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    if (prev !== null && previousDay(d) === prev) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
    prev = d;
  }

  // current streak ending today or yesterday
  let cursor = todayStr;
  if (!days.has(cursor)) cursor = previousDay(cursor);
  if (!days.has(cursor)) return { current: 0, longest };
  let current = 0;
  while (days.has(cursor)) {
    current += 1;
    cursor = previousDay(cursor);
  }
  return { current, longest };
}

function buildTrend(
  rows: { day: string; answered: number; correct: number }[],
  todayStr: string,
  days: number = 30,
): DailyStat[] {
  const map = new Map<string, { answered: number; correct: number }>();
  for (const r of rows) {
    map.set(r.day, { answered: r.answered, correct: r.correct });
  }
  const out: DailyStat[] = [];
  let cursor = todayStr;
  for (let i = 0; i < days; i += 1) {
    const s = map.get(cursor) ?? { answered: 0, correct: 0 };
    out.unshift({ day: cursor, answered: s.answered, correct: s.correct });
    cursor = previousDay(cursor);
  }
  return out;
}

export async function getHistoryReport(
  tzOffsetMin: number,
  now: number = Date.now(),
): Promise<HistoryReport> {
  const db = await initDb();
  const tzOffsetMs = tzOffsetMin * 60_000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const todayStr = toDayString(now, tzOffsetMin);

  const [
    overviewRes,
    studyDaysRes,
    trendRes,
    materialRes,
    nodeRes,
    sessionRes,
    typeRes,
    diffRes,
  ] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct FROM answers`,
      args: [],
    }),
    db.execute({
      sql: `SELECT DISTINCT strftime('%Y-%m-%d', (answered_at + ?)/1000, 'unixepoch') AS day FROM answers`,
      args: [tzOffsetMs],
    }),
    db.execute({
      sql: `SELECT
              strftime('%Y-%m-%d', (answered_at + ?)/1000, 'unixepoch') AS day,
              COUNT(*) AS answered,
              COALESCE(SUM(is_correct), 0) AS correct
            FROM answers
            WHERE answered_at >= ?
            GROUP BY day
            ORDER BY day ASC`,
      args: [tzOffsetMs, thirtyDaysAgo],
    }),
    db.execute({
      sql: `SELECT
              s.material_id AS material_id,
              m.title AS material_title,
              COUNT(a.id) AS answered,
              COALESCE(SUM(a.is_correct), 0) AS correct
            FROM quiz_sessions s
            LEFT JOIN materials m ON m.id = s.material_id
            JOIN quiz_questions q ON q.session_id = s.id
            JOIN answers a ON a.question_id = q.id
            GROUP BY s.material_id, m.title
            ORDER BY (CAST(correct AS REAL) / answered) ASC, answered DESC`,
      args: [],
    }),
    db.execute({
      sql: `SELECT
              s.material_id AS material_id,
              m.title AS material_title,
              s.node_key AS node_key,
              s.node_title AS node_title,
              COUNT(a.id) AS answered,
              COALESCE(SUM(a.is_correct), 0) AS correct
            FROM quiz_sessions s
            JOIN quiz_questions q ON q.session_id = s.id
            JOIN answers a ON a.question_id = q.id
            LEFT JOIN materials m ON m.id = s.material_id
            WHERE s.node_title IS NOT NULL
            GROUP BY s.material_id, s.node_key, s.node_title
            HAVING answered >= 1
            ORDER BY (CAST(correct AS REAL) / answered) ASC, answered DESC
            LIMIT 10`,
      args: [],
    }),
    db.execute({
      sql: `SELECT
              s.id AS session_id,
              s.material_id AS material_id,
              m.title AS material_title,
              s.node_title AS node_title,
              s.type AS type,
              s.difficulty AS difficulty,
              s.question_count AS question_count,
              s.created_at AS created_at,
              COUNT(a.id) AS answered,
              COALESCE(SUM(a.is_correct), 0) AS correct
            FROM quiz_sessions s
            LEFT JOIN materials m ON m.id = s.material_id
            JOIN quiz_questions q ON q.session_id = s.id
            JOIN answers a ON a.question_id = q.id
            GROUP BY s.id
            ORDER BY MAX(a.answered_at) DESC
            LIMIT 10`,
      args: [],
    }),
    db.execute({
      sql: `SELECT q.type AS type,
              COUNT(a.id) AS answered,
              COALESCE(SUM(a.is_correct), 0) AS correct
            FROM answers a
            JOIN quiz_questions q ON q.id = a.question_id
            GROUP BY q.type`,
      args: [],
    }),
    db.execute({
      sql: `SELECT s.difficulty AS difficulty,
              COUNT(a.id) AS answered,
              COALESCE(SUM(a.is_correct), 0) AS correct
            FROM answers a
            JOIN quiz_questions q ON q.id = a.question_id
            JOIN quiz_sessions s ON s.id = q.session_id
            GROUP BY s.difficulty`,
      args: [],
    }),
  ]);

  const total = Number(overviewRes.rows[0].total);
  const correct = Number(overviewRes.rows[0].correct);

  const dayStrs = new Set<string>();
  for (const r of studyDaysRes.rows) {
    if (r.day) dayStrs.add(r.day as string);
  }
  const { current, longest } = computeStreaks(dayStrs, todayStr);

  const overview: HistoryOverview = {
    totalAnswers: total,
    correctAnswers: correct,
    accuracy: safeAccuracy(correct, total),
    studyDays: dayStrs.size,
    currentStreak: current,
    longestStreak: longest,
  };

  const trend = buildTrend(
    trendRes.rows.map((r) => ({
      day: r.day as string,
      answered: Number(r.answered),
      correct: Number(r.correct),
    })),
    todayStr,
  );

  const byMaterial: MaterialStat[] = materialRes.rows.map((r) => {
    const answered = Number(r.answered);
    const c = Number(r.correct);
    return {
      materialId: (r.material_id as string | null) ?? null,
      materialTitle: (r.material_title as string | null) ?? null,
      answered,
      correct: c,
      accuracy: safeAccuracy(c, answered),
    };
  });

  const weakestNodes: NodeStat[] = nodeRes.rows.map((r) => {
    const answered = Number(r.answered);
    const c = Number(r.correct);
    return {
      materialId: (r.material_id as string | null) ?? null,
      materialTitle: (r.material_title as string | null) ?? null,
      nodeKey: (r.node_key as string | null) ?? null,
      nodeTitle: r.node_title as string,
      answered,
      correct: c,
      accuracy: safeAccuracy(c, answered),
    };
  });

  const recentSessions: SessionStat[] = sessionRes.rows.map((r) => {
    const answered = Number(r.answered);
    const c = Number(r.correct);
    return {
      sessionId: r.session_id as string,
      materialId: (r.material_id as string | null) ?? null,
      materialTitle: (r.material_title as string | null) ?? null,
      nodeTitle: (r.node_title as string | null) ?? null,
      type: r.type as QuestionType,
      difficulty: r.difficulty as Difficulty,
      questionCount: Number(r.question_count),
      createdAt: Number(r.created_at),
      answered,
      correct: c,
    };
  });

  const byType: TypeStat[] = typeRes.rows.map((r) => {
    const answered = Number(r.answered);
    const c = Number(r.correct);
    return {
      type: r.type as QuestionType,
      answered,
      correct: c,
      accuracy: safeAccuracy(c, answered),
    };
  });

  const byDifficulty: DifficultyStat[] = diffRes.rows.map((r) => {
    const answered = Number(r.answered);
    const c = Number(r.correct);
    return {
      difficulty: r.difficulty as Difficulty,
      answered,
      correct: c,
      accuracy: safeAccuracy(c, answered),
    };
  });

  return {
    overview,
    byMaterial,
    weakestNodes,
    trend,
    recentSessions,
    byType,
    byDifficulty,
    generatedAt: now,
    tzOffsetMin,
  };
}
