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

  `CREATE TABLE IF NOT EXISTS study_groups (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    purpose TEXT,
    target_completion_date TEXT,
    memo TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_study_groups_sort ON study_groups(sort_order ASC, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS study_projects (
    id TEXT PRIMARY KEY,
    study_group_id TEXT,
    title TEXT NOT NULL,
    purpose TEXT,
    memo TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    target_completion_date TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (study_group_id) REFERENCES study_groups(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_study_projects_updated ON study_projects(updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS project_materials (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    original_file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    media_category TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    text_content TEXT NOT NULL,
    page_count INTEGER,
    duration_seconds INTEGER,
    upload_status TEXT NOT NULL,
    analysis_status TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES study_projects(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_materials_project ON project_materials(project_id, uploaded_at DESC)`,

  `CREATE TABLE IF NOT EXISTS project_analysis (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE,
    total_materials INTEGER NOT NULL,
    total_file_size_bytes INTEGER NOT NULL,
    total_pages INTEGER NOT NULL,
    total_audio_seconds INTEGER NOT NULL,
    estimated_total_study_minutes INTEGER NOT NULL,
    combined_structure_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES study_projects(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS study_plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    target_completion_date TEXT,
    study_style TEXT NOT NULL,
    total_rounds INTEGER NOT NULL,
    weekday_minutes_json TEXT NOT NULL,
    include_quiz INTEGER NOT NULL,
    include_review_days INTEGER NOT NULL,
    include_audio_learning INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES study_projects(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_study_plans_project ON study_plans(project_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS study_note_exports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    topic_key TEXT,
    topic_title TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES study_projects(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_study_note_exports_project ON study_note_exports(project_id, created_at DESC)`,
];

const MIGRATIONS = [
  `ALTER TABLE study_projects ADD COLUMN study_group_id TEXT`,
  `ALTER TABLE study_projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_study_projects_group ON study_projects(study_group_id, sort_order ASC)`,
];

export async function initDb(): Promise<Client> {
  const db = getDb();
  if (!initialized) {
    for (const stmt of SCHEMA) {
      await db.execute(stmt);
    }
  }
  for (const stmt of MIGRATIONS) {
    try {
      await db.execute(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (!lower.includes("duplicate column") && !lower.includes("already exists")) {
        throw err;
      }
    }
  }
  initialized = true;
  return db;
}
