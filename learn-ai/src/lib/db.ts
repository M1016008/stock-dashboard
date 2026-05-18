import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DB_PATH = path.join(process.cwd(), "data", "learn-ai.db");

let client: Client | null = null;
let initialized = false;

function ensureDataDir() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

export function getDb(): Client {
  if (!client) {
    ensureDataDir();
    client = createClient({ url: `file:${DB_PATH}` });
  }
  return client;
}

const SCHEMA = [
  `PRAGMA foreign_keys = ON`,

  `CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    original_text TEXT NOT NULL,
    structure_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_materials_created ON materials(created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS quiz_sessions (
    id TEXT PRIMARY KEY,
    material_id TEXT,
    node_key TEXT,
    node_title TEXT,
    source_label TEXT,
    type TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    question_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_created ON quiz_sessions(created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS quiz_questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    question_index INTEGER NOT NULL,
    type TEXT NOT NULL,
    question TEXT NOT NULL,
    choices_json TEXT,
    answer INTEGER NOT NULL,
    explanation TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES quiz_sessions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_questions_session ON quiz_questions(session_id)`,

  `CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id TEXT NOT NULL,
    selected_index INTEGER NOT NULL,
    is_correct INTEGER NOT NULL,
    answered_at INTEGER NOT NULL,
    FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id)`,
  `CREATE INDEX IF NOT EXISTS idx_answers_time ON answers(answered_at)`,

  `CREATE TABLE IF NOT EXISTS srs_cards (
    question_id TEXT PRIMARY KEY,
    ease REAL NOT NULL DEFAULT 2.5,
    interval_days REAL NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL,
    last_reviewed_at INTEGER,
    last_rating TEXT,
    FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_srs_due ON srs_cards(due_at)`,

  `CREATE TABLE IF NOT EXISTS problem_sets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    material_id TEXT,
    source_text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_problem_sets_created ON problem_sets(created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    problem_set_id TEXT NOT NULL,
    problem_index INTEGER NOT NULL,
    number_label TEXT,
    question_text TEXT NOT NULL,
    choices_json TEXT,
    answer_text TEXT,
    original_explanation TEXT,
    augmented_json TEXT,
    augmented_at INTEGER,
    FOREIGN KEY (problem_set_id) REFERENCES problem_sets(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_problems_set ON problems(problem_set_id, problem_index)`,
];

export async function initDb(): Promise<Client> {
  const db = getDb();
  if (initialized) return db;
  for (const stmt of SCHEMA) {
    await db.execute(stmt);
  }
  initialized = true;
  return db;
}
