import { initDb } from "@/lib/db";
import { analyzeStructure, type DocumentStructure } from "@/lib/ai/structure";
import type { AiProvider } from "@/lib/ai/types";
import { extractPdfText } from "@/lib/pdf";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const MAX_ANALYSIS_CHARS = 60_000;

export type StudyProject = {
  id: string;
  studyGroupId: string | null;
  title: string;
  purpose: string;
  memo: string;
  sortOrder: number;
  targetCompletionDate: string;
  status: "draft" | "analyzed" | "learning" | "completed";
  createdAt: number;
  updatedAt: number;
};

export type StudyGroup = {
  id: string;
  title: string;
  purpose: string;
  targetCompletionDate: string;
  memo: string;
  sortOrder: number;
  status: "active" | "completed" | "paused";
  createdAt: number;
  updatedAt: number;
};

export type ProjectMaterial = {
  id: string;
  projectId: string;
  title: string;
  originalFileName: string;
  fileType: string;
  mediaCategory: "pdf" | "word" | "text" | "audio" | "other";
  fileSizeBytes: number;
  textContent: string;
  pageCount: number | null;
  durationSeconds: number | null;
  uploadStatus: "uploaded";
  analysisStatus: "pending" | "analyzed";
  uploadedAt: number;
  updatedAt: number;
};

export type ProjectAnalysis = {
  id: string;
  projectId: string;
  totalMaterials: number;
  totalFileSizeBytes: number;
  totalPages: number;
  totalAudioSeconds: number;
  estimatedTotalStudyMinutes: number;
  combinedStructure: DocumentStructure;
  createdAt: number;
  updatedAt: number;
};

export type StudyPlan = {
  id: string;
  projectId: string;
  targetCompletionDate: string;
  studyStyle: string;
  totalRounds: number;
  weekdayMinutes: Record<string, number>;
  includeQuiz: boolean;
  includeReviewDays: boolean;
  includeAudioLearning: boolean;
  plan: GeneratedStudyPlan;
  status: "active" | "draft";
  createdAt: number;
  updatedAt: number;
};

export type GeneratedStudyPlan = {
  summary: {
    totalDays: number;
    totalMinutes: number;
    dailyAverageMinutes: number;
    estimatedRequiredMinutes: number;
  };
  rounds: Array<{
    round: number;
    title: string;
    goal: string;
    minutes: number;
    focus: string[];
  }>;
  tasks: Array<{
    day: number;
    date: string;
    round: number;
    title: string;
    minutes: number;
    materialTitle?: string;
    taskType: "read" | "listen" | "note" | "quiz" | "review";
  }>;
  advice: string[];
};

export type StudyNoteExportContent = {
  summary?: string;
  learningGoal?: string;
  importance?: string;
  explanation?: string;
  extraKnowledge?: string;
  keyPoint?: string;
  excerpt?: string;
  keywords?: Array<{
    term: string;
    meaning: string;
    example?: string;
    image?: string;
  }>;
  pageLabel?: string;
};

export type StudyNoteExport = {
  id: string;
  projectId: string;
  title: string;
  topicKey: string | null;
  topicTitle: string;
  content: StudyNoteExportContent;
  createdAt: number;
  updatedAt: number;
};

type DbRow = Record<string, unknown>;

export async function listStudyGroups() {
  const db = await initDb();
  const result = await db.execute(
    "SELECT * FROM study_groups ORDER BY sort_order ASC, updated_at DESC",
  );
  const groups = result.rows.map((row) => mapGroup(row as DbRow));
  const projects = await listStudyProjects();
  return groups.map((group) => {
    const groupProjects = projects.filter((project) => project.studyGroupId === group.id);
    return {
      ...group,
      projects: groupProjects,
      progress: summarizeGroupProgress(groupProjects),
    };
  });
}

export async function createStudyGroup(input: {
  title: string;
  purpose?: string;
  targetCompletionDate?: string;
  memo?: string;
}) {
  const db = await initDb();
  const now = Date.now();
  const orderRes = await db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM study_groups");
  const group: StudyGroup = {
    id: crypto.randomUUID(),
    title: input.title.trim(),
    purpose: input.purpose?.trim() ?? "",
    targetCompletionDate: input.targetCompletionDate ?? "",
    memo: input.memo?.trim() ?? "",
    sortOrder: Number(orderRes.rows[0]?.next_order ?? 1),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await db.execute({
    sql: `INSERT INTO study_groups
      (id, title, purpose, target_completion_date, memo, sort_order, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      group.id,
      group.title,
      group.purpose,
      group.targetCompletionDate,
      group.memo,
      group.sortOrder,
      group.status,
      group.createdAt,
      group.updatedAt,
    ],
  });
  return group;
}

export async function getStudyGroup(id: string) {
  const db = await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM study_groups WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  const group = mapGroup(row as DbRow);
  const projects = (await listStudyProjects()).filter(
    (project) => project.studyGroupId === group.id,
  );
  return {
    ...group,
    projects,
    progress: summarizeGroupProgress(projects),
  };
}

export async function updateStudyGroup(
  id: string,
  input: Partial<{
    title: string;
    purpose: string;
    targetCompletionDate: string;
    memo: string;
    status: StudyGroup["status"];
  }>,
) {
  const current = await getStudyGroup(id);
  if (!current) return null;
  const db = await initDb();
  const updated: StudyGroup = {
    id: current.id,
    title: input.title?.trim() || current.title,
    purpose: input.purpose ?? current.purpose,
    targetCompletionDate: input.targetCompletionDate ?? current.targetCompletionDate,
    memo: input.memo ?? current.memo,
    sortOrder: current.sortOrder,
    status: input.status ?? current.status,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
  };
  await db.execute({
    sql: `UPDATE study_groups
      SET title = ?, purpose = ?, target_completion_date = ?, memo = ?, status = ?, updated_at = ?
      WHERE id = ?`,
    args: [
      updated.title,
      updated.purpose,
      updated.targetCompletionDate,
      updated.memo,
      updated.status,
      updated.updatedAt,
      updated.id,
    ],
  });
  return updated;
}

export async function deleteStudyGroup(id: string) {
  const db = await initDb();
  await db.execute({
    sql: "UPDATE study_projects SET study_group_id = NULL, updated_at = ? WHERE study_group_id = ?",
    args: [Date.now(), id],
  });
  const res = await db.execute({
    sql: "DELETE FROM study_groups WHERE id = ?",
    args: [id],
  });
  return res.rowsAffected > 0;
}

export async function setProjectGroup(projectId: string, studyGroupId: string | null) {
  const db = await initDb();
  if (studyGroupId) {
    const group = await getStudyGroup(studyGroupId);
    if (!group) throw new Error("学習グループが見つかりません。");
  }
  const orderRes = studyGroupId
    ? await db.execute({
        sql: "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM study_projects WHERE study_group_id = ?",
        args: [studyGroupId],
      })
    : await db.execute(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM study_projects WHERE study_group_id IS NULL",
      );
  await db.execute({
    sql: "UPDATE study_projects SET study_group_id = ?, sort_order = ?, updated_at = ? WHERE id = ?",
    args: [studyGroupId, Number(orderRes.rows[0]?.next_order ?? 1), Date.now(), projectId],
  });
  return getStudyProject(projectId);
}

export async function reorderProjectsInGroup(groupId: string, projectIds: string[]) {
  const db = await initDb();
  const now = Date.now();
  await db.batch(
    projectIds.map((projectId, index) => ({
      sql: "UPDATE study_projects SET study_group_id = ?, sort_order = ?, updated_at = ? WHERE id = ?",
      args: [groupId, index + 1, now, projectId],
    })),
    "write",
  );
  return getStudyGroup(groupId);
}

export async function listStudyProjects() {
  const db = await initDb();
  const result = await db.execute(
    "SELECT * FROM study_projects ORDER BY study_group_id IS NULL ASC, sort_order ASC, updated_at DESC",
  );
  const projects = result.rows.map(mapProject);
  const enriched = await Promise.all(
    projects.map(async (project) => {
      const materials = await listProjectMaterials(project.id);
      const analysis = await getProjectAnalysis(project.id);
      const plan = await getLatestStudyPlan(project.id);
      return { ...project, materials, analysis, plan };
    }),
  );
  return enriched;
}

export async function createStudyProject(input: {
  title: string;
  purpose?: string;
  memo?: string;
  targetCompletionDate?: string;
  studyGroupId?: string | null;
}) {
  const db = await initDb();
  const now = Date.now();
  const project: StudyProject = {
    id: crypto.randomUUID(),
    studyGroupId: input.studyGroupId ?? null,
    title: input.title.trim(),
    purpose: input.purpose?.trim() ?? "",
    memo: input.memo?.trim() ?? "",
    sortOrder: 0,
    targetCompletionDate: input.targetCompletionDate ?? "",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  const orderRes = project.studyGroupId
    ? await db.execute({
        sql: "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM study_projects WHERE study_group_id = ?",
        args: [project.studyGroupId],
      })
    : await db.execute(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM study_projects WHERE study_group_id IS NULL",
      );
  project.sortOrder = Number(orderRes.rows[0]?.next_order ?? 1);
  await db.execute({
    sql: `INSERT INTO study_projects
      (id, study_group_id, title, purpose, memo, sort_order, target_completion_date, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      project.id,
      project.studyGroupId,
      project.title,
      project.purpose,
      project.memo,
      project.sortOrder,
      project.targetCompletionDate,
      project.status,
      project.createdAt,
      project.updatedAt,
    ],
  });
  return project;
}

export async function getStudyProject(id: string) {
  const db = await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM study_projects WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  const project = mapProject(row as DbRow);
  return {
    ...project,
    materials: await listProjectMaterials(id),
    analysis: await getProjectAnalysis(id),
    plan: await getLatestStudyPlan(id),
  };
}

export async function addMaterialsToProject(projectId: string, files: File[]) {
  const db = await initDb();
  const project = await getStudyProject(projectId);
  if (!project) throw new Error("学習プロジェクトが見つかりません。");

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_UPLOAD_BYTES) {
    throw new Error("1回のアップロードは合計100MBまでです。");
  }

  const now = Date.now();
  const materials: ProjectMaterial[] = [];
  for (const file of files) {
    const material = await materialFromFile(projectId, file, now);
    await db.execute({
      sql: `INSERT INTO project_materials
        (id, project_id, title, original_file_name, file_type, media_category,
         file_size_bytes, text_content, page_count, duration_seconds,
         upload_status, analysis_status, uploaded_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        material.id,
        material.projectId,
        material.title,
        material.originalFileName,
        material.fileType,
        material.mediaCategory,
        material.fileSizeBytes,
        material.textContent,
        material.pageCount,
        material.durationSeconds,
        material.uploadStatus,
        material.analysisStatus,
        material.uploadedAt,
        material.updatedAt,
      ],
    });
    materials.push(material);
  }

  await touchProject(projectId, "draft");
  return materials;
}

export async function listProjectMaterials(projectId: string) {
  const db = await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM project_materials WHERE project_id = ? ORDER BY uploaded_at DESC",
    args: [projectId],
  });
  return result.rows.map((row) => mapMaterial(row as DbRow));
}

export async function analyzeStudyProject(projectId: string, provider: AiProvider) {
  const db = await initDb();
  const materials = await listProjectMaterials(projectId);
  if (materials.length === 0) {
    throw new Error("解析する教材がまだ登録されていません。");
  }

  const combinedText = materials
    .map((material) => {
      const label = `[${material.mediaCategory.toUpperCase()}] ${material.title}`;
      return `${label}\n${material.textContent}`;
    })
    .join("\n\n---\n\n")
    .slice(0, MAX_ANALYSIS_CHARS);

  const combinedStructure = await analyzeWithFallback(combinedText, provider);
  const totalPages = materials.reduce((sum, m) => sum + (m.pageCount ?? 0), 0);
  const totalAudioSeconds = materials.reduce(
    (sum, m) => sum + (m.durationSeconds ?? 0),
    0,
  );
  const totalFileSizeBytes = materials.reduce((sum, m) => sum + m.fileSizeBytes, 0);
  const textMinutes = Math.max(30, Math.ceil(combinedText.length / 450));
  const audioMinutes = Math.ceil(totalAudioSeconds / 60);
  const estimatedTotalStudyMinutes = Math.ceil((textMinutes + audioMinutes) * 2.2);
  const now = Date.now();

  const analysis: ProjectAnalysis = {
    id: crypto.randomUUID(),
    projectId,
    totalMaterials: materials.length,
    totalFileSizeBytes,
    totalPages,
    totalAudioSeconds,
    estimatedTotalStudyMinutes,
    combinedStructure,
    createdAt: now,
    updatedAt: now,
  };

  await db.execute({
    sql: `INSERT INTO project_analysis
      (id, project_id, total_materials, total_file_size_bytes, total_pages,
       total_audio_seconds, estimated_total_study_minutes, combined_structure_json,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        total_materials = excluded.total_materials,
        total_file_size_bytes = excluded.total_file_size_bytes,
        total_pages = excluded.total_pages,
        total_audio_seconds = excluded.total_audio_seconds,
        estimated_total_study_minutes = excluded.estimated_total_study_minutes,
        combined_structure_json = excluded.combined_structure_json,
        updated_at = excluded.updated_at`,
    args: [
      analysis.id,
      analysis.projectId,
      analysis.totalMaterials,
      analysis.totalFileSizeBytes,
      analysis.totalPages,
      analysis.totalAudioSeconds,
      analysis.estimatedTotalStudyMinutes,
      JSON.stringify(analysis.combinedStructure),
      analysis.createdAt,
      analysis.updatedAt,
    ],
  });
  await db.execute({
    sql: "UPDATE project_materials SET analysis_status = ?, updated_at = ? WHERE project_id = ?",
    args: ["analyzed", now, projectId],
  });
  await touchProject(projectId, "analyzed");

  return analysis;
}

export async function getProjectAnalysis(projectId: string) {
  const db = await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM project_analysis WHERE project_id = ?",
    args: [projectId],
  });
  const row = result.rows[0];
  return row ? mapAnalysis(row as DbRow) : null;
}

export async function generateStudyPlan(input: {
  projectId: string;
  targetCompletionDate?: string;
  studyStyle: string;
  weekdayMinutes: Record<string, number>;
  includeQuiz: boolean;
  includeReviewDays: boolean;
  includeAudioLearning: boolean;
}) {
  const db = await initDb();
  const project = await getStudyProject(input.projectId);
  if (!project) throw new Error("学習プロジェクトが見つかりません。");

  const analysis =
    project.analysis ??
    (await analyzeStudyProject(input.projectId, "anthropic" as AiProvider));
  const materials = project.materials;
  const targetDate =
    input.targetCompletionDate || project.targetCompletionDate || isoAfterDays(21);
  const plan = buildPlan({
    materials,
    analysis,
    targetDate,
    weekdayMinutes: input.weekdayMinutes,
    studyStyle: input.studyStyle,
    includeQuiz: input.includeQuiz,
    includeReviewDays: input.includeReviewDays,
    includeAudioLearning: input.includeAudioLearning,
  });

  const now = Date.now();
  const saved: StudyPlan = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    targetCompletionDate: targetDate,
    studyStyle: input.studyStyle,
    totalRounds: 3,
    weekdayMinutes: input.weekdayMinutes,
    includeQuiz: input.includeQuiz,
    includeReviewDays: input.includeReviewDays,
    includeAudioLearning: input.includeAudioLearning,
    plan,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  await db.execute({
    sql: `INSERT INTO study_plans
      (id, project_id, target_completion_date, study_style, total_rounds,
       weekday_minutes_json, include_quiz, include_review_days,
       include_audio_learning, plan_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      saved.id,
      saved.projectId,
      saved.targetCompletionDate,
      saved.studyStyle,
      saved.totalRounds,
      JSON.stringify(saved.weekdayMinutes),
      saved.includeQuiz ? 1 : 0,
      saved.includeReviewDays ? 1 : 0,
      saved.includeAudioLearning ? 1 : 0,
      JSON.stringify(saved.plan),
      saved.status,
      saved.createdAt,
      saved.updatedAt,
    ],
  });
  await touchProject(input.projectId, "learning");
  return saved;
}

export async function getLatestStudyPlan(projectId: string) {
  const db = await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM study_plans WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    args: [projectId],
  });
  const row = result.rows[0];
  return row ? mapPlan(row as DbRow) : null;
}

export async function listStudyNoteExports(projectId: string) {
  const db = await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM study_note_exports WHERE project_id = ? ORDER BY created_at DESC",
    args: [projectId],
  });
  return result.rows.map((row) => mapStudyNoteExport(row as DbRow));
}

export async function getStudyNoteExport(id: string) {
  const db = await initDb();
  const result = await db.execute({
    sql: "SELECT * FROM study_note_exports WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  return row ? mapStudyNoteExport(row as DbRow) : null;
}

export async function createStudyNoteExport(input: {
  projectId: string;
  title: string;
  topicKey?: string | null;
  topicTitle: string;
  content: StudyNoteExportContent;
}) {
  const project = await getStudyProject(input.projectId);
  if (!project) throw new Error("学習プロジェクトが見つかりません。");
  const db = await initDb();
  const now = Date.now();
  const note: StudyNoteExport = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    title: input.title.trim() || input.topicTitle,
    topicKey: input.topicKey ?? null,
    topicTitle: input.topicTitle,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  };
  await db.execute({
    sql: `INSERT INTO study_note_exports
      (id, project_id, title, topic_key, topic_title, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      note.id,
      note.projectId,
      note.title,
      note.topicKey,
      note.topicTitle,
      JSON.stringify(note.content),
      note.createdAt,
      note.updatedAt,
    ],
  });
  return note;
}

async function materialFromFile(
  projectId: string,
  file: File,
  now: number,
): Promise<ProjectMaterial> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mediaCategory = detectCategory(file.name, file.type);
  const buffer = await file.arrayBuffer();
  const textContent = await extractTextForMaterial(file, buffer, mediaCategory);
  const pageCount =
    mediaCategory === "pdf" ? Math.max(1, Math.ceil(textContent.length / 1800)) : null;
  const durationSeconds =
    mediaCategory === "audio" ? estimateAudioSeconds(file.size) : null;

  return {
    id: crypto.randomUUID(),
    projectId,
    title: titleFromFilename(file.name),
    originalFileName: file.name,
    fileType: extension || file.type || "unknown",
    mediaCategory,
    fileSizeBytes: file.size,
    textContent,
    pageCount,
    durationSeconds,
    uploadStatus: "uploaded",
    analysisStatus: "pending",
    uploadedAt: now,
    updatedAt: now,
  };
}

async function extractTextForMaterial(
  file: File,
  buffer: ArrayBuffer,
  category: ProjectMaterial["mediaCategory"],
) {
  if (category === "pdf") {
    return extractPdfText(buffer);
  }
  if (category === "text") {
    return new TextDecoder("utf-8").decode(buffer);
  }
  if (category === "word") {
    return [
      `${file.name} はWord教材として登録されました。`,
      "本文抽出は次の段階でdocxパーサーに差し替えられるよう、教材単位のメタデータとして保持しています。",
      "まずはファイル名と他教材の解析結果を使って学習計画に組み込みます。",
    ].join("\n");
  }
  if (category === "audio") {
    return [
      `${file.name} は音声教材として登録されました。`,
      "音声の文字起こし、話題分割、タイムスタンプ付き復習はAPI接続後に自動生成される想定です。",
      "現時点では推定再生時間を使い、1周目は聴講、2周目は要点確認、3周目はクイズ復習に配分します。",
    ].join("\n");
  }
  return `${file.name} を教材として登録しました。`;
}

async function analyzeWithFallback(text: string, provider: AiProvider) {
  try {
    return await analyzeStructure(text, provider);
  } catch {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8);
    return {
      title: "学習プロジェクト全体の構造",
      nodes: lines.map((line, index) => ({
        id: `fallback-${index + 1}`,
        title: line.slice(0, 36),
        summary: line,
        learningGoal: "この教材で扱う中心テーマをつかむ",
        importance: "計画作成と復習対象の優先順位づけに使います。",
        explanation: line,
        extraKnowledge: "詳しいAIノートはAPIキー設定後に再解析すると更新できます。",
        keyPoint: "まずは全体像、次に細部、最後に問題演習の順で学びます。",
        children: [],
      })),
      keywords: [
        {
          term: "学習プロジェクト",
          meaning: "複数の教材をひとまとまりの学習目的として扱う単位",
          example: "PDF、Word、講義音声をまとめて資格試験対策にする",
          image: "教材を入れたフォルダのようなもの",
        },
      ],
    } satisfies DocumentStructure;
  }
}

function buildPlan(input: {
  materials: ProjectMaterial[];
  analysis: ProjectAnalysis;
  targetDate: string;
  weekdayMinutes: Record<string, number>;
  studyStyle: string;
  includeQuiz: boolean;
  includeReviewDays: boolean;
  includeAudioLearning: boolean;
}): GeneratedStudyPlan {
  const today = startOfToday();
  const end = new Date(`${input.targetDate}T00:00:00`);
  const totalDays = Math.max(1, diffDays(today, end) + 1);
  const estimatedRequiredMinutes = input.analysis.estimatedTotalStudyMinutes;
  const roundWeights = [0.48, 0.32, 0.2];
  const rounds = [
    {
      round: 1,
      title: "1周目: 全体理解",
      goal: "教材の流れをつかみ、知らない言葉を減らす",
      minutes: Math.ceil(estimatedRequiredMinutes * roundWeights[0]),
      focus: ["本文を読む", "音声を聞く", "重要語句を確認"],
    },
    {
      round: 2,
      title: "2周目: 整理と復習",
      goal: "章ごとのつながりを説明できる状態にする",
      minutes: Math.ceil(estimatedRequiredMinutes * roundWeights[1]),
      focus: ["ノート確認", "弱点メモ", "短い確認問題"],
    },
    {
      round: 3,
      title: "3周目: 演習と弱点補強",
      goal: "試験や実務で使える形まで引き上げる",
      minutes: Math.ceil(estimatedRequiredMinutes * roundWeights[2]),
      focus: ["クイズ", "間違い直し", "総復習"],
    },
  ];

  const tasks: GeneratedStudyPlan["tasks"] = [];
  let remaining = rounds.map((round) => round.minutes);
  let materialIndex = 0;
  for (let day = 1; day <= totalDays && remaining.some((m) => m > 0); day += 1) {
    const date = addDays(today, day - 1);
    const weekdayKey = String(date.getDay());
    let capacity = input.weekdayMinutes[weekdayKey] ?? 30;
    if (capacity <= 0) continue;
    const roundIndex = remaining.findIndex((m) => m > 0);
    if (roundIndex < 0) break;
    const minutes = Math.min(capacity, remaining[roundIndex]);
    const material = input.materials[materialIndex % Math.max(1, input.materials.length)];
    const taskType = chooseTaskType(
      roundIndex + 1,
      material,
      input.includeQuiz,
      input.includeAudioLearning,
    );
    tasks.push({
      day,
      date: toIsoDate(date),
      round: roundIndex + 1,
      title: taskTitle(roundIndex + 1, taskType),
      minutes,
      materialTitle: material?.title,
      taskType,
    });
    remaining[roundIndex] -= minutes;
    capacity -= minutes;
    materialIndex += 1;
  }

  const totalMinutes = rounds.reduce((sum, round) => sum + round.minutes, 0);
  return {
    summary: {
      totalDays,
      totalMinutes,
      dailyAverageMinutes: Math.ceil(totalMinutes / totalDays),
      estimatedRequiredMinutes,
    },
    rounds,
    tasks,
    advice: [
      "1周目は完璧を狙わず、全体像と用語の意味を先に固めましょう。",
      input.includeReviewDays
        ? "復習日を挟む設定なので、忘れかけたタイミングで短く戻れます。"
        : "復習日なしの設定なので、毎日の最後に5分だけ振り返ると安定します。",
      input.studyStyle === "exam"
        ? "試験対策寄りなので、3周目はクイズと間違い直しを厚めにしています。"
        : "理解重視なので、説明できるかを確認しながら進めると効果的です。",
    ],
  };
}

function chooseTaskType(
  round: number,
  material: ProjectMaterial | undefined,
  includeQuiz: boolean,
  includeAudio: boolean,
): GeneratedStudyPlan["tasks"][number]["taskType"] {
  if (material?.mediaCategory === "audio" && includeAudio && round === 1) return "listen";
  if (round === 1) return "read";
  if (round === 2) return "note";
  return includeQuiz ? "quiz" : "review";
}

function taskTitle(round: number, taskType: string) {
  if (taskType === "listen") return "講義音声を聞き、要点をメモする";
  if (taskType === "read") return "教材を読み、全体像をつかむ";
  if (taskType === "note") return "AIノートを見直し、つながりを整理する";
  if (taskType === "quiz") return "確認クイズで弱点を見つける";
  return round === 3 ? "弱点を復習して仕上げる" : "復習する";
}

async function touchProject(projectId: string, status: StudyProject["status"]) {
  const db = await initDb();
  await db.execute({
    sql: "UPDATE study_projects SET status = ?, updated_at = ? WHERE id = ?",
    args: [status, Date.now(), projectId],
  });
}

function detectCategory(name: string, mime: string): ProjectMaterial["mediaCategory"] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "word";
  if (lower.endsWith(".mp3") || lower.endsWith(".m4a") || lower.endsWith(".wav")) {
    return "audio";
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md") || mime.startsWith("text/")) {
    return "text";
  }
  return "other";
}

function estimateAudioSeconds(bytes: number) {
  return Math.max(60, Math.round(bytes / 16000));
}

function titleFromFilename(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || name;
}

function mapProject(row: DbRow): StudyProject {
  return {
    id: String(row.id),
    studyGroupId: row.study_group_id === null || row.study_group_id === undefined
      ? null
      : String(row.study_group_id),
    title: String(row.title),
    purpose: String(row.purpose ?? ""),
    memo: String(row.memo ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
    targetCompletionDate: String(row.target_completion_date ?? ""),
    status: String(row.status) as StudyProject["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapGroup(row: DbRow): StudyGroup {
  return {
    id: String(row.id),
    title: String(row.title),
    purpose: String(row.purpose ?? ""),
    targetCompletionDate: String(row.target_completion_date ?? ""),
    memo: String(row.memo ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
    status: String(row.status ?? "active") as StudyGroup["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function summarizeGroupProgress(
  projects: Array<StudyProject & {
    materials?: ProjectMaterial[];
    analysis?: ProjectAnalysis | null;
    plan?: StudyPlan | null;
  }>,
) {
  const projectCount = projects.length;
  const totalMinutes = projects.reduce(
    (sum, project) => sum + (project.plan?.plan.summary.totalMinutes ?? project.analysis?.estimatedTotalStudyMinutes ?? 0),
    0,
  );
  const readiness = projects.reduce((sum, project) => {
    if (project.plan) return sum + 45;
    if (project.analysis) return sum + 25;
    if ((project.materials?.length ?? 0) > 0) return sum + 10;
    return sum;
  }, 0);
  const progressPercent = projectCount ? Math.round(readiness / projectCount) : 0;
  const status =
    projectCount === 0
      ? "未開始"
      : progressPercent >= 70
        ? "順調"
        : progressPercent >= 30
          ? "やや遅れ"
          : "遅れあり";
  return {
    projectCount,
    progressPercent,
    totalMinutes,
    status,
    targetCompletionDate: projects
      .map((project) => project.targetCompletionDate)
      .filter(Boolean)
      .sort()[0] ?? "",
  };
}

function mapMaterial(row: DbRow): ProjectMaterial {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    originalFileName: String(row.original_file_name),
    fileType: String(row.file_type),
    mediaCategory: String(row.media_category) as ProjectMaterial["mediaCategory"],
    fileSizeBytes: Number(row.file_size_bytes),
    textContent: String(row.text_content ?? ""),
    pageCount: row.page_count === null ? null : Number(row.page_count),
    durationSeconds:
      row.duration_seconds === null ? null : Number(row.duration_seconds),
    uploadStatus: "uploaded",
    analysisStatus: String(row.analysis_status) as ProjectMaterial["analysisStatus"],
    uploadedAt: Number(row.uploaded_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapAnalysis(row: DbRow): ProjectAnalysis {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    totalMaterials: Number(row.total_materials),
    totalFileSizeBytes: Number(row.total_file_size_bytes),
    totalPages: Number(row.total_pages),
    totalAudioSeconds: Number(row.total_audio_seconds),
    estimatedTotalStudyMinutes: Number(row.estimated_total_study_minutes),
    combinedStructure: JSON.parse(String(row.combined_structure_json)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapPlan(row: DbRow): StudyPlan {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    targetCompletionDate: String(row.target_completion_date ?? ""),
    studyStyle: String(row.study_style),
    totalRounds: Number(row.total_rounds),
    weekdayMinutes: JSON.parse(String(row.weekday_minutes_json)),
    includeQuiz: Number(row.include_quiz) === 1,
    includeReviewDays: Number(row.include_review_days) === 1,
    includeAudioLearning: Number(row.include_audio_learning) === 1,
    plan: JSON.parse(String(row.plan_json)),
    status: String(row.status) as StudyPlan["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapStudyNoteExport(row: DbRow): StudyNoteExport {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    topicKey: row.topic_key === null || row.topic_key === undefined
      ? null
      : String(row.topic_key),
    topicTitle: String(row.topic_title),
    content: JSON.parse(String(row.content_json)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function diffDays(a: Date, b: Date) {
  return Math.ceil((b.getTime() - a.getTime()) / 86_400_000);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isoAfterDays(days: number) {
  return toIsoDate(addDays(startOfToday(), days));
}
