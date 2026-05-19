"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AiProvider } from "@/lib/ai/types";
import type {
  GeneratedStudyPlan,
  ProjectAnalysis,
  ProjectMaterial,
  StudyGroup,
  StudyNoteExport,
  StudyPlan,
  StudyProject,
} from "@/lib/study-projects";
import type {
  DocumentStructure,
  KeywordEntry,
  StructureNode,
} from "@/lib/ai/structure";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

type ProjectPayload = StudyProject & {
  materials: ProjectMaterial[];
  analysis: ProjectAnalysis | null;
  plan: StudyPlan | null;
};

type GroupPayload = StudyGroup & {
  projects: ProjectPayload[];
  progress: {
    projectCount: number;
    progressPercent: number;
    totalMinutes: number;
    status: string;
    targetCompletionDate: string;
  };
};

type Props = {
  provider: AiProvider;
};

type LearningProgress = {
  completedTopics: string[];
  completedTasks: string[];
};

type ProgressSummary = {
  plannedPercent: number;
  actualPercent: number;
  plannedMinutes: number;
  actualMinutes: number;
  totalMinutes: number;
  behindMinutes: number;
  behindDays: number;
  completedTopics: number;
  totalTopics: number;
  completedTasks: number;
  totalTasks: number;
  status: "ahead" | "on-track" | "behind" | "not-started";
};

export function ProjectWorkspace({ provider }: Props) {
  const [projects, setProjects] = useState<ProjectPayload[]>([]);
  const [groups, setGroups] = useState<GroupPayload[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [targetDate, setTargetDate] = useState(defaultTargetDate());
  const [groupTitle, setGroupTitle] = useState("");
  const [groupPurpose, setGroupPurpose] = useState("");
  const [groupTargetDate, setGroupTargetDate] = useState(defaultTargetDate());
  const [files, setFiles] = useState<File[]>([]);
  const [studyStyle, setStudyStyle] = useState("exam");
  const [weekdayMinutes, setWeekdayMinutes] = useState<Record<string, number>>({
    "0": 45,
    "1": 30,
    "2": 30,
    "3": 30,
    "4": 30,
    "5": 45,
    "6": 60,
  });
  const [includeQuiz, setIncludeQuiz] = useState(true);
  const [includeReviewDays, setIncludeReviewDays] = useState(true);
  const [includeAudioLearning, setIncludeAudioLearning] = useState(true);
  const [activeTopicKey, setActiveTopicKey] = useState<string | null>(null);
  const [progressByProject, setProgressByProject] = useState<Record<string, LearningProgress>>({});
  const [notesByProject, setNotesByProject] = useState<Record<string, StudyNoteExport[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = projects.find((project) => project.id === selectedId) ?? projects[0];
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const visibleProjects = selectedGroupId
    ? projects.filter((project) => project.studyGroupId === selectedGroupId)
    : projects;
  const queuedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const uploadRatio = Math.min(100, Math.round((queuedBytes / MAX_UPLOAD_BYTES) * 100));
  const overLimit = queuedBytes > MAX_UPLOAD_BYTES;
  const todayTasks = selected?.plan?.plan.tasks.slice(0, 4) ?? [];
  const structure = selected?.analysis?.combinedStructure ?? null;
  const projectProgress = selected
    ? progressByProject[selected.id] ?? emptyProgress()
    : emptyProgress();
  const progressSummary = selected
    ? buildProgressSummary(selected, structure, projectProgress)
    : null;
  const activeTopic =
    structure && activeTopicKey
      ? findTopicByKey(structure.nodes, activeTopicKey) ?? firstTopic(structure.nodes)
      : structure
        ? firstTopic(structure.nodes)
        : null;
  const savedNotes = selected ? notesByProject[selected.id] ?? [] : [];

  useEffect(() => {
    void refreshProjects();
  }, []);

  useEffect(() => {
    setActiveTopicKey(null);
  }, [selectedId]);

  useEffect(() => {
    if (selected?.id) {
      void refreshNotes(selected.id);
    }
  }, [selected?.id]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("study-project-progress-v1");
      if (raw) setProgressByProject(JSON.parse(raw));
    } catch {
      setProgressByProject({});
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "study-project-progress-v1",
        JSON.stringify(progressByProject),
      );
    } catch {
      // localStorage is best-effort progress persistence.
    }
  }, [progressByProject]);

  function updateProjectProgress(
    projectId: string,
    updater: (progress: LearningProgress) => LearningProgress,
  ) {
    setProgressByProject((prev) => ({
      ...prev,
      [projectId]: updater(prev[projectId] ?? emptyProgress()),
    }));
  }

  function toggleTopicDone(topicKey: string) {
    if (!selected) return;
    updateProjectProgress(selected.id, (progress) => ({
      ...progress,
      completedTopics: toggleItem(progress.completedTopics, topicKey),
    }));
  }

  function toggleTaskDone(taskKey: string) {
    if (!selected) return;
    updateProjectProgress(selected.id, (progress) => ({
      ...progress,
      completedTasks: toggleItem(progress.completedTasks, taskKey),
    }));
  }

  async function refreshProjects(nextSelectedId?: string) {
    const [projectsRes, groupsRes] = await Promise.all([
      fetch("/api/study-projects"),
      fetch("/api/study-groups"),
    ]);
    const body = await projectsRes.json();
    const groupBody = await groupsRes.json();
    if (!projectsRes.ok) throw new Error(body.error ?? "プロジェクト一覧を取得できませんでした。");
    if (!groupsRes.ok) throw new Error(groupBody.error ?? "グループ一覧を取得できませんでした。");
    setProjects(body.projects ?? []);
    setGroups(groupBody.groups ?? []);
    if (nextSelectedId) {
      setSelectedId(nextSelectedId);
    } else if (!selectedId && body.projects?.[0]?.id) {
      setSelectedId(body.projects[0].id);
    }
  }

  async function refreshNotes(projectId: string) {
    const res = await fetch(`/api/study-projects/${projectId}/notes`);
    const body = await res.json();
    if (!res.ok) return;
    setNotesByProject((prev) => ({
      ...prev,
      [projectId]: body.notes ?? [],
    }));
  }

  async function runAction<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createProject(e: FormEvent) {
    e.preventDefault();
    await runAction("create", async () => {
      const res = await fetch("/api/study-projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          purpose,
          targetCompletionDate: targetDate,
          studyGroupId: selectedGroupId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "作成に失敗しました。");
      setTitle("");
      setPurpose("");
      await refreshProjects(body.project.id);
    });
  }

  async function createGroup(e: FormEvent) {
    e.preventDefault();
    await runAction("create-group", async () => {
      const res = await fetch("/api/study-groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: groupTitle,
          purpose: groupPurpose,
          targetCompletionDate: groupTargetDate,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "グループ作成に失敗しました。");
      setGroupTitle("");
      setGroupPurpose("");
      setSelectedGroupId(body.group.id);
      await refreshProjects(selectedId ?? undefined);
    });
  }

  async function changeProjectGroup(projectId: string, groupId: string | null) {
    await runAction("move-group", async () => {
      const res = await fetch(`/api/study-projects/${projectId}/group`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ studyGroupId: groupId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "グループ変更に失敗しました。");
      await refreshProjects(projectId);
    });
  }

  async function saveTopicNote(input: {
    topic: StructureNode;
    topicKey: string | null;
    keywords: KeywordEntry[];
    pageLabel: string;
  }) {
    if (!selected) return;
    await runAction("save-note", async () => {
      const res = await fetch(`/api/study-projects/${selected.id}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `${selected.title} - ${input.topic.title}`,
          topicKey: input.topicKey,
          topicTitle: input.topic.title,
          content: {
            summary: input.topic.summary,
            learningGoal: input.topic.learningGoal,
            importance: input.topic.importance,
            explanation: input.topic.explanation,
            extraKnowledge: input.topic.extraKnowledge,
            keyPoint: input.topic.keyPoint,
            excerpt: input.topic.excerpt,
            keywords: input.keywords,
            pageLabel: input.pageLabel,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "ノート保存に失敗しました。");
      await refreshNotes(selected.id);
    });
  }

  async function uploadMaterials() {
    if (!selected || files.length === 0 || overLimit) return;
    await runAction("upload", async () => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      const res = await fetch(`/api/study-projects/${selected.id}/materials/upload`, {
        method: "POST",
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "アップロードに失敗しました。");
      setFiles([]);
      await refreshProjects(selected.id);
    });
  }

  async function analyzeProject() {
    if (!selected) return;
    await runAction("analyze", async () => {
      const res = await fetch(`/api/study-projects/${selected.id}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "解析に失敗しました。");
      await refreshProjects(selected.id);
    });
  }

  async function generatePlan() {
    if (!selected) return;
    await runAction("plan", async () => {
      const res = await fetch("/api/study-plans/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: selected.id,
          targetCompletionDate: selected.targetCompletionDate || targetDate,
          studyStyle,
          weekdayMinutes,
          includeQuiz,
          includeReviewDays,
          includeAudioLearning,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "学習計画の生成に失敗しました。");
      await refreshProjects(selected.id);
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <section className="rounded-2xl border border-white/80 bg-white/82 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <div className="rounded-2xl border border-teal-100 bg-teal-50/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
                  Study Groups
                </p>
                <h2 className="mt-1 text-lg font-semibold text-slate-950">
                  学習グループ
                </h2>
              </div>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-teal-800">
                {groups.length}件
              </span>
            </div>

            <form onSubmit={createGroup} className="mt-4 space-y-2">
              <input
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                className="w-full rounded-xl border border-teal-100 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500"
                placeholder="例: 司法試験対策"
              />
              <textarea
                value={groupPurpose}
                onChange={(e) => setGroupPurpose(e.target.value)}
                className="min-h-16 w-full rounded-xl border border-teal-100 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500"
                placeholder="目的・メモ"
              />
              <input
                type="date"
                value={groupTargetDate}
                onChange={(e) => setGroupTargetDate(e.target.value)}
                className="w-full rounded-xl border border-teal-100 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500"
              />
              <button
                type="submit"
                disabled={!groupTitle.trim() || busy === "create-group"}
                className="w-full rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-teal-700/20 disabled:bg-slate-300"
              >
                {busy === "create-group" ? "作成中..." : "グループを作成"}
              </button>
            </form>

            <div className="mt-4 space-y-2">
              <GroupCard
                title="すべて"
                projectCount={projects.length}
                progressPercent={projects.length ? Math.round(projects.reduce((sum, project) => sum + (project.plan ? 45 : project.analysis ? 25 : project.materials.length ? 10 : 0), 0) / projects.length) : 0}
                status="全体"
                selected={selectedGroupId === null}
                onClick={() => setSelectedGroupId(null)}
              />
              {groups.map((group) => (
                <GroupCard
                  key={group.id}
                  title={group.title}
                  projectCount={group.progress.projectCount}
                  progressPercent={group.progress.progressPercent}
                  status={group.progress.status}
                  selected={selectedGroupId === group.id}
                  onClick={() => setSelectedGroupId(group.id)}
                />
              ))}
            </div>
          </div>

          {selectedGroup && (
            <GroupOverview group={selectedGroup} />
          )}

          <div className="mt-5 border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
                Study Projects
              </p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">
                教材プロジェクト
              </h2>
            </div>
            <span className="rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800">
              {visibleProjects.length}件
            </span>
          </div>

          <form onSubmit={createProject} className="mt-5 space-y-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500"
              placeholder="例: 宅建 権利関係"
            />
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              className="min-h-20 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500"
              placeholder="学習目的、試験日、苦手意識など"
            />
            <label className="block text-xs font-semibold text-slate-600">
              目標完了日
              <input
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              所属グループ
              <select
                value={selectedGroupId ?? ""}
                onChange={(e) => setSelectedGroupId(e.target.value || null)}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500"
              >
                <option value="">未所属</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={!title.trim() || busy === "create"}
              className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-slate-900/15 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {busy === "create" ? "作成中..." : "新規プロジェクトを作成"}
            </button>
          </form>

          <div className="mt-5 space-y-2">
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                groups={groups}
                selected={project.id === selected?.id}
                onClick={() => setSelectedId(project.id)}
                onChangeGroup={(groupId) => changeProjectGroup(project.id, groupId)}
              />
            ))}
            {visibleProjects.length === 0 && (
              <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
                このグループにはまだプロジェクトがありません。
              </p>
            )}
          </div>
          </div>
        </section>

        <section className="space-y-5">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          {selected ? (
            <>
              <ProjectHero project={selected} progressSummary={progressSummary} />

              <ProgressCommandCenter
                project={selected}
                structure={structure}
                progress={projectProgress}
                summary={progressSummary}
                onToggleTask={toggleTaskDone}
                onSelectTopic={setActiveTopicKey}
              />

              <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
                <UploadPanel
                  files={files}
                  setFiles={setFiles}
                  queuedBytes={queuedBytes}
                  uploadRatio={uploadRatio}
                  overLimit={overLimit}
                  busy={busy}
                  onUpload={uploadMaterials}
                />
                <AnalysisPanel
                  project={selected}
                  busy={busy}
                  onAnalyze={analyzeProject}
                />
              </div>

              <MaterialsPanel materials={selected.materials} />

              <LearningStructurePanel
                structure={structure}
                materials={selected.materials}
                activeKey={activeTopicKey}
                activeTopic={activeTopic}
                progress={projectProgress}
                onSelectTopic={setActiveTopicKey}
                onToggleTopic={toggleTopicDone}
                onSaveTopicNote={saveTopicNote}
              />

              <SavedNotesPanel notes={savedNotes} />

              <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
                <StudySettingsForm
                  studyStyle={studyStyle}
                  setStudyStyle={setStudyStyle}
                  weekdayMinutes={weekdayMinutes}
                  setWeekdayMinutes={setWeekdayMinutes}
                  includeQuiz={includeQuiz}
                  setIncludeQuiz={setIncludeQuiz}
                  includeReviewDays={includeReviewDays}
                  setIncludeReviewDays={setIncludeReviewDays}
                  includeAudioLearning={includeAudioLearning}
                  setIncludeAudioLearning={setIncludeAudioLearning}
                  busy={busy}
                  disabled={selected.materials.length === 0}
                  onGenerate={generatePlan}
                />
                <PlanPreview
                  plan={selected.plan?.plan ?? null}
                  todayTasks={todayTasks}
                  progress={projectProgress}
                  onToggleTask={toggleTaskDone}
                />
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-8 text-center text-slate-500">
              プロジェクトを選ぶと、教材アップロードと学習計画を開始できます。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  groups,
  selected,
  onClick,
  onChangeGroup,
}: {
  project: ProjectPayload;
  groups: GroupPayload[];
  selected: boolean;
  onClick: () => void;
  onChangeGroup: (groupId: string | null) => void;
}) {
  const fileBreakdown = useMemo(() => summarizeMaterials(project.materials), [project.materials]);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className={`w-full rounded-xl border p-4 text-left transition ${
        selected
          ? "border-teal-400 bg-teal-50/80 shadow-sm"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-950">{project.title}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-slate-500">
            {project.purpose || "目的は未設定です。"}
          </p>
        </div>
        <StatusPill status={project.status} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-600">
        <Metric label="教材" value={`${project.materials.length}件`} />
        <Metric label="容量" value={formatBytes(totalBytes(project.materials))} />
        <Metric label="内訳" value={fileBreakdown} />
      </div>
      <label className="mt-3 block text-xs font-semibold text-slate-500" onClick={(e) => e.stopPropagation()}>
        所属
        <select
          value={project.studyGroupId ?? ""}
          onChange={(e) => onChangeGroup(e.target.value || null)}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-teal-500"
        >
          <option value="">未所属</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function GroupCard({
  title,
  projectCount,
  progressPercent,
  status,
  selected,
  onClick,
}: {
  title: string;
  projectCount: number;
  progressPercent: number;
  status: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border p-3 text-left transition ${
        selected
          ? "border-teal-400 bg-white shadow-sm"
          : "border-transparent bg-white/70 hover:border-teal-200 hover:bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-slate-950">{title}</h3>
          <p className="mt-1 text-xs text-slate-500">
            {projectCount}プロジェクト / {status}
          </p>
        </div>
        <span className="rounded-full bg-teal-50 px-2 py-1 text-xs font-bold text-teal-700">
          {progressPercent}%
        </span>
      </div>
      <div className="mt-3 h-2 rounded-full bg-slate-100">
        <div
          className="h-2 rounded-full bg-teal-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </button>
  );
}

function GroupOverview({ group }: { group: GroupPayload }) {
  const projectNames = group.projects.slice(0, 5).map((project) => project.title).join(" / ");
  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">
            Group Summary
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-950">{group.title}</h3>
          {group.purpose && (
            <p className="mt-1 text-sm leading-6 text-slate-500">{group.purpose}</p>
          )}
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {group.progress.status}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Metric label="進捗" value={`${group.progress.progressPercent}%`} />
        <Metric label="期限" value={group.targetCompletionDate || group.progress.targetCompletionDate || "未設定"} />
        <Metric label="学習量" value={`${group.progress.totalMinutes}分`} />
      </div>
      <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
        {projectNames
          ? `含まれるプロジェクト: ${projectNames}`
          : "このグループにプロジェクトを追加すると、グループ単位の進捗が見えるようになります。"}
      </p>
    </div>
  );
}

function ProjectHero({
  project,
  progressSummary,
}: {
  project: ProjectPayload;
  progressSummary: ProgressSummary | null;
}) {
  const progress =
    progressSummary?.actualPercent ??
    (project.plan ? 28 : project.analysis ? 18 : project.materials.length ? 8 : 0);
  const behindText =
    progressSummary && project.plan
      ? progressSummary.behindMinutes > 0
        ? `${progressSummary.behindMinutes}分ビハインド`
        : "予定どおり"
      : "計画未作成";
  return (
    <div className="overflow-hidden rounded-2xl border border-white/80 bg-slate-950 text-white shadow-[0_22px_60px_rgba(15,23,42,0.18)]">
      <div className="bg-[radial-gradient(circle_at_top_right,rgba(45,212,191,0.30),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(56,189,248,0.20),transparent_28%),linear-gradient(135deg,#0f172a,#123b3b)] p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-100">
              Active Project
            </p>
            <h2 className="mt-2 text-2xl font-semibold">{project.title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-200">
              {project.purpose || "教材を追加して、解析と3周学習計画を開始しましょう。"}
            </p>
          </div>
          <div className="grid min-w-72 grid-cols-2 gap-2 rounded-xl bg-white/10 p-2 backdrop-blur sm:grid-cols-4">
            <Metric label="教材" value={`${project.materials.length}件`} dark />
            <Metric
              label="学習量"
              value={
                project.analysis
                  ? `${project.analysis.estimatedTotalStudyMinutes}分`
                  : "未解析"
              }
              dark
            />
            <Metric label="期限" value={project.targetCompletionDate || "未設定"} dark />
            <Metric label="予定差分" value={behindText} dark />
          </div>
        </div>
        <div className="mt-6 h-2 rounded-full bg-white/15">
          <div
            className="h-2 rounded-full bg-teal-300 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function ProgressCommandCenter({
  project,
  structure,
  progress,
  summary,
  onToggleTask,
  onSelectTopic,
}: {
  project: ProjectPayload;
  structure: DocumentStructure | null;
  progress: LearningProgress;
  summary: ProgressSummary | null;
  onToggleTask: (taskKey: string) => void;
  onSelectTopic: (topicKey: string) => void;
}) {
  if (!summary) return null;

  const plan = project.plan?.plan ?? null;
  const urgentTasks = getActionTasks(plan, progress);
  const weakTopics = getWeakTopics(structure, progress).slice(0, 3);
  const recovery = buildRecoveryAdvice(summary, plan);
  const statusLabel =
    summary.status === "behind"
      ? `${summary.behindDays}日遅れ`
      : summary.status === "ahead"
        ? "予定より前倒し"
        : summary.status === "not-started"
          ? "学習開始前"
          : "予定どおり";

  return (
    <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
      <div className="rounded-2xl border border-white/80 bg-white/90 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
              Progress Control
            </p>
            <h3 className="mt-1 text-xl font-semibold text-slate-950">
              計画に対する進捗
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              今日時点の予定進捗と実績を比べて、遅れを自動で見える化します。
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              summary.status === "behind"
                ? "bg-rose-50 text-rose-700"
                : summary.status === "ahead"
                  ? "bg-sky-50 text-sky-700"
                  : "bg-teal-50 text-teal-800"
            }`}
          >
            {statusLabel}
          </span>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <ProgressStat
            label="予定進捗"
            value={`${summary.plannedPercent}%`}
            sub={`${summary.plannedMinutes}分分まで進む予定`}
          />
          <ProgressStat
            label="実績進捗"
            value={`${summary.actualPercent}%`}
            sub={`${summary.actualMinutes}分相当を完了`}
          />
          <ProgressStat
            label="ビハインド"
            value={
              summary.behindMinutes > 0
                ? `${summary.behindMinutes}分`
                : "0分"
            }
            sub={
              summary.behindMinutes > 0
                ? `約${summary.behindDays}日分の遅れ`
                : "このペースでOK"
            }
            danger={summary.behindMinutes > 0}
          />
        </div>

        <div className="mt-5 space-y-4">
          <ProgressBarPair
            label="予定 vs 実績"
            planned={summary.plannedPercent}
            actual={summary.actualPercent}
          />
          <RoundProgressBars plan={plan} progress={progress} />
        </div>
      </div>

      <div className="space-y-5">
        <div className="rounded-2xl border border-white/80 bg-white/90 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <h3 className="text-lg font-semibold text-slate-950">今日やるべきこと</h3>
          <p className="mt-1 text-sm text-slate-500">
            遅れている場合は、未完了の古いタスクを先に出します。
          </p>
          <div className="mt-4 space-y-3">
            {urgentTasks.length > 0 ? (
              urgentTasks.map((task) => {
                const key = taskKey(task);
                const done = progress.completedTasks.includes(key);
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 transition hover:bg-white"
                  >
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={() => onToggleTask(key)}
                      className="mt-1 h-4 w-4 accent-teal-600"
                    />
                    <span className="min-w-0">
                      <span className={done ? "block text-sm font-semibold text-slate-400 line-through" : "block text-sm font-semibold text-slate-950"}>
                        {task.title}
                      </span>
                      <span className="mt-1 block text-xs text-slate-500">
                        {task.date} / {task.minutes}分 / {task.materialTitle ?? "教材横断"}
                      </span>
                    </span>
                  </label>
                );
              })
            ) : (
              <p className="rounded-xl bg-teal-50 p-4 text-sm text-teal-900">
                今日の未完了タスクはありません。余裕があれば弱点単元を復習しましょう。
              </p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/80 bg-white/90 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <h3 className="text-lg font-semibold text-slate-950">リカバリー提案</h3>
          <p className="mt-3 rounded-xl bg-slate-950 p-4 text-sm leading-6 text-white">
            {recovery}
          </p>
          {weakTopics.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                優先して戻る単元
              </p>
              {weakTopics.map((topic) => (
                <button
                  key={topic.key}
                  type="button"
                  onClick={() => onSelectTopic(topic.key)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50"
                >
                  {topic.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ProgressStat({
  label,
  value,
  sub,
  danger = false,
}: {
  label: string;
  value: string;
  sub: string;
  danger?: boolean;
}) {
  return (
    <div className={danger ? "rounded-2xl border border-rose-100 bg-rose-50 p-4" : "rounded-2xl border border-slate-200 bg-slate-50 p-4"}>
      <p className={danger ? "text-xs font-bold text-rose-700" : "text-xs font-bold text-slate-500"}>
        {label}
      </p>
      <p className={danger ? "mt-1 text-3xl font-semibold text-rose-700" : "mt-1 text-3xl font-semibold text-slate-950"}>
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function ProgressBarPair({
  label,
  planned,
  actual,
}: {
  label: string;
  planned: number;
  actual: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
        <span>{label}</span>
        <span>予定 {planned}% / 実績 {actual}%</span>
      </div>
      <div className="mt-2 h-3 rounded-full bg-slate-100">
        <div className="h-3 rounded-full bg-slate-300" style={{ width: `${planned}%` }} />
        <div
          className="-mt-3 h-3 rounded-full bg-teal-500"
          style={{ width: `${actual}%` }}
        />
      </div>
    </div>
  );
}

function RoundProgressBars({
  plan,
  progress,
}: {
  plan: GeneratedStudyPlan | null;
  progress: LearningProgress;
}) {
  if (!plan) {
    return (
      <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
        学習計画を生成すると、1周目・2周目・3周目の進捗が表示されます。
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {plan.rounds.map((round) => {
        const tasks = plan.tasks.filter((task) => task.round === round.round);
        const done = tasks.filter((task) => progress.completedTasks.includes(taskKey(task))).length;
        const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
        return (
          <div key={round.round} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
              <span>{round.title}</span>
              <span>{percent}%</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-slate-100">
              <div className="h-2 rounded-full bg-teal-500" style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UploadPanel({
  files,
  setFiles,
  queuedBytes,
  uploadRatio,
  overLimit,
  busy,
  onUpload,
}: {
  files: File[];
  setFiles: (files: File[]) => void;
  queuedBytes: number;
  uploadRatio: number;
  overLimit: boolean;
  busy: string | null;
  onUpload: () => void;
}) {
  return (
    <div className="rounded-2xl border border-white/80 bg-white/85 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">教材アップロード</h3>
          <p className="mt-1 text-sm text-slate-500">
            PDF / Word / テキスト / 音声をまとめて登録できます。
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          100MBまで
        </span>
      </div>
      <label className="mt-5 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-teal-300 bg-teal-50/60 px-4 py-8 text-center transition hover:bg-teal-50">
        <span className="text-sm font-semibold text-teal-900">
          ファイルを選択
        </span>
        <span className="mt-1 text-xs text-teal-700">
          .pdf .docx .txt .md .mp3 .m4a .wav
        </span>
        <input
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.txt,.md,.mp3,.m4a,.wav"
          className="sr-only"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
      </label>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
          <span>{formatBytes(queuedBytes)} / 100MB</span>
          <span>{uploadRatio}%</span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-100">
          <div
            className={`h-2 rounded-full ${overLimit ? "bg-rose-500" : "bg-teal-500"}`}
            style={{ width: `${uploadRatio}%` }}
          />
        </div>
        {overLimit && (
          <p className="mt-2 text-xs font-semibold text-rose-600">
            合計容量が100MBを超えています。
          </p>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {files.map((file) => (
          <div
            key={`${file.name}-${file.size}`}
            className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"
          >
            <span className="truncate pr-3 text-slate-700">{file.name}</span>
            <span className="shrink-0 text-xs font-semibold text-slate-500">
              {formatBytes(file.size)}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onUpload}
        disabled={files.length === 0 || overLimit || busy === "upload"}
        className="mt-4 w-full rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-teal-600/20 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {busy === "upload" ? "登録中..." : "教材を登録する"}
      </button>
    </div>
  );
}

function AnalysisPanel({
  project,
  busy,
  onAnalyze,
}: {
  project: ProjectPayload;
  busy: string | null;
  onAnalyze: () => void;
}) {
  const analysis = project.analysis;
  return (
    <div className="rounded-2xl border border-white/80 bg-white/85 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <h3 className="text-lg font-semibold text-slate-950">解析ステータス</h3>
      <div className="mt-4 space-y-3">
        <Step done={project.materials.length > 0} label="教材登録" />
        <Step done={Boolean(analysis)} label="教材横断解析" />
        <Step done={Boolean(project.plan)} label="3周学習計画" />
      </div>
      {analysis && (
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Metric label="総教材" value={`${analysis.totalMaterials}件`} />
          <Metric label="総容量" value={formatBytes(analysis.totalFileSizeBytes)} />
          <Metric label="ページ" value={`${analysis.totalPages}p`} />
          <Metric label="推定学習" value={`${analysis.estimatedTotalStudyMinutes}分`} />
        </div>
      )}
      <button
        type="button"
        onClick={onAnalyze}
        disabled={project.materials.length === 0 || busy === "analyze"}
        className="mt-5 w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {busy === "analyze" ? "解析中..." : "教材を横断解析する"}
      </button>
    </div>
  );
}

function MaterialsPanel({ materials }: { materials: ProjectMaterial[] }) {
  return (
    <div className="rounded-2xl border border-white/80 bg-white/85 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-950">登録教材</h3>
        <span className="text-sm font-semibold text-slate-500">{materials.length}件</span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {materials.map((material) => (
          <div key={material.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-teal-700">
                  {material.mediaCategory}
                </p>
                <h4 className="mt-1 line-clamp-2 font-semibold text-slate-950">
                  {material.title}
                </h4>
              </div>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                {material.analysisStatus === "analyzed" ? "解析済" : "待機中"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <Metric label="容量" value={formatBytes(material.fileSizeBytes)} />
              <Metric
                label={material.mediaCategory === "audio" ? "推定時間" : "ページ"}
                value={
                  material.mediaCategory === "audio"
                    ? formatSeconds(material.durationSeconds ?? 0)
                    : material.pageCount
                      ? `${material.pageCount}p`
                      : "-"
                }
              />
            </div>
          </div>
        ))}
        {materials.length === 0 && (
          <p className="text-sm text-slate-500">まだ教材が登録されていません。</p>
        )}
      </div>
    </div>
  );
}

function LearningStructurePanel({
  structure,
  materials,
  activeKey,
  activeTopic,
  progress,
  onSelectTopic,
  onToggleTopic,
  onSaveTopicNote,
}: {
  structure: DocumentStructure | null;
  materials: ProjectMaterial[];
  activeKey: string | null;
  activeTopic: StructureNode | null;
  progress: LearningProgress;
  onSelectTopic: (key: string) => void;
  onToggleTopic: (key: string) => void;
  onSaveTopicNote: (input: {
    topic: StructureNode;
    topicKey: string | null;
    keywords: KeywordEntry[];
    pageLabel: string;
  }) => void;
}) {
  if (!structure) {
    return (
      <div className="rounded-2xl border border-dashed border-teal-200 bg-white/75 p-6 text-center shadow-[0_18px_50px_rgba(15,23,42,0.06)]">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
          Learning Map
        </p>
        <h3 className="mt-2 text-lg font-semibold text-slate-950">
          解析すると、章・節からそのまま学習を開始できます
        </h3>
        <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-slate-500">
          教材を横断解析すると、AIが章・節・トピックに整理します。学びたい項目をクリックするだけで、解説・重要ポイント・キーワード・クイズ候補が開きます。
        </p>
      </div>
    );
  }

  const selectedKey = activeKey ?? firstTopicKey(structure.nodes);
  const relatedKeywords = pickRelatedKeywords(activeTopic, structure.keywords ?? []);

  return (
    <div className="rounded-2xl border border-white/80 bg-white/88 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
            Learning Map
          </p>
          <h3 className="mt-1 text-xl font-semibold text-slate-950">
            教材構造から学習を開始
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            章・節を選ぶと、右側に学習詳細がすぐ表示されます。
          </p>
        </div>
        <span className="rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800">
          1クリックで学習開始
        </span>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
          <div className="mb-3 flex items-center justify-between px-1">
            <h4 className="text-sm font-semibold text-slate-900">{structure.title}</h4>
            <span className="text-xs font-semibold text-slate-500">
              {countTopics(structure.nodes)}項目
            </span>
          </div>
          <TopicTree
            nodes={structure.nodes}
            activeKey={selectedKey}
            onSelect={onSelectTopic}
          />
          <ChapterProgressList nodes={structure.nodes} progress={progress} />
        </div>

        <LearningTopicDetail
          topic={activeTopic}
          topicKey={selectedKey}
          keywords={relatedKeywords}
          materials={materials}
          done={selectedKey ? progress.completedTopics.includes(selectedKey) : false}
          onToggleDone={() => {
            if (selectedKey) onToggleTopic(selectedKey);
          }}
          onSaveNote={(pageLabel) => {
            if (activeTopic) {
              onSaveTopicNote({
                topic: activeTopic,
                topicKey: selectedKey,
                keywords: relatedKeywords,
                pageLabel,
              });
            }
          }}
        />
      </div>
    </div>
  );
}

function TopicTree({
  nodes,
  activeKey,
  onSelect,
  depth = 0,
  pathPrefix = "",
}: {
  nodes: StructureNode[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  depth?: number;
  pathPrefix?: string;
}) {
  return (
    <ul className={depth === 0 ? "space-y-2" : "ml-4 mt-2 space-y-2 border-l border-slate-200 pl-3"}>
      {nodes.map((node, index) => {
        const key = `${pathPrefix}/${index}`;
        const selected = activeKey === key;
        const hasChildren = (node.children?.length ?? 0) > 0;
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onSelect(key)}
              className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                selected
                  ? "border-teal-400 bg-white text-teal-950 shadow-sm"
                  : "border-transparent bg-white/70 text-slate-700 hover:border-teal-200 hover:bg-white"
              }`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                    selected ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{node.title}</span>
                  {node.summary && (
                    <span className="mt-1 line-clamp-2 block text-xs leading-5 text-slate-500">
                      {node.summary}
                    </span>
                  )}
                </span>
              </div>
            </button>
            {hasChildren && (
              <TopicTree
                nodes={node.children ?? []}
                activeKey={activeKey}
                onSelect={onSelect}
                depth={depth + 1}
                pathPrefix={key}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ChapterProgressList({
  nodes,
  progress,
}: {
  nodes: StructureNode[];
  progress: LearningProgress;
}) {
  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
      <h4 className="text-sm font-semibold text-slate-950">章ごとの進捗</h4>
      <div className="mt-3 space-y-3">
        {nodes.map((node, index) => {
          const key = `/${index}`;
          const keys = collectNodeKeys(node, key);
          const done = keys.filter((k) => progress.completedTopics.includes(k)).length;
          const percent = keys.length ? Math.round((done / keys.length) * 100) : 0;
          return (
            <div key={key}>
              <div className="flex items-center justify-between gap-3 text-xs font-semibold">
                <span className="truncate text-slate-700">{node.title}</span>
                <span className="text-slate-500">{percent}%</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-slate-100">
                <div
                  className="h-2 rounded-full bg-teal-500"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LearningTopicDetail({
  topic,
  topicKey,
  keywords,
  materials,
  done,
  onToggleDone,
  onSaveNote,
}: {
  topic: StructureNode | null;
  topicKey: string | null;
  keywords: KeywordEntry[];
  materials: ProjectMaterial[];
  done: boolean;
  onToggleDone: () => void;
  onSaveNote: (pageLabel: string) => void;
}) {
  if (!topic) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
        左の章・節を選ぶと、ここに学習詳細が表示されます。
      </div>
    );
  }

  const pageLabel = estimatePageLabel(topicKey, materials);
  const quizSeeds = buildQuizSeeds(topic);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
            Study Detail
          </p>
          <h4 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            {topic.title}
          </h4>
          {topic.summary && (
            <p className="mt-2 text-sm leading-6 text-slate-500">{topic.summary}</p>
          )}
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {pageLabel}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-teal-100 bg-teal-50/70 p-3">
        <button
          type="button"
          onClick={onToggleDone}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
            done
              ? "bg-teal-600 text-white shadow-sm shadow-teal-700/20"
              : "bg-white text-teal-800 hover:bg-teal-100"
          }`}
        >
          {done ? "学習済み" : "この単元を完了にする"}
        </button>
        <p className="text-sm text-teal-900">
          完了にすると、計画進捗と章ごとの進捗に反映されます。
        </p>
        <button
          type="button"
          onClick={() => onSaveNote(pageLabel)}
          className="ml-auto rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          解説をアプリに保存
        </button>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <LearningBlock title="何を学ぶのか" body={topic.learningGoal} />
        <LearningBlock title="なぜ重要なのか" body={topic.importance} />
        <LearningBlock
          title="小学生でもわかる解説"
          body={topic.explanation || topic.summary}
          wide
        />
        <LearningBlock title="補足知識" body={topic.extraKnowledge} />
        <LearningBlock title="★ここ大事" body={topic.keyPoint} important />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h5 className="text-sm font-semibold text-slate-950">関連キーワード</h5>
          <div className="mt-3 space-y-2">
            {keywords.length > 0 ? (
              keywords.map((keyword) => (
                <div key={keyword.term} className="rounded-lg bg-white p-3">
                  <p className="font-semibold text-teal-800">{keyword.term}</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{keyword.meaning}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    例: {keyword.example || keyword.image}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">
                この項目に強く関連するキーワードは、再解析後に表示されます。
              </p>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h5 className="text-sm font-semibold text-slate-950">関連する問題・クイズ</h5>
          <div className="mt-3 space-y-2">
            {quizSeeds.map((seed, index) => (
              <div key={seed} className="rounded-lg bg-white p-3 text-sm text-slate-700">
                <span className="mr-2 font-bold text-teal-700">Q{index + 1}</span>
                {seed}
              </div>
            ))}
          </div>
          <p className="mt-3 rounded-lg bg-teal-50 p-3 text-xs leading-5 text-teal-900">
            本格的な演習は「問題集」タブで作成できます。この欄では、今選んだ単元からすぐ確認すべき問いを先に見せます。
          </p>
        </div>
      </div>

      {topic.excerpt && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <h5 className="text-sm font-semibold text-slate-950">教材内の根拠</h5>
          <p className="mt-2 text-sm leading-6 text-slate-600">{topic.excerpt}</p>
        </div>
      )}
    </div>
  );
}

function LearningBlock({
  title,
  body,
  important = false,
  wide = false,
}: {
  title: string;
  body?: string;
  important?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        important
          ? "border-amber-200 bg-amber-50"
          : "border-slate-200 bg-slate-50"
      } ${wide ? "md:col-span-2" : ""}`}
    >
      <h5 className={important ? "text-sm font-bold text-amber-900" : "text-sm font-semibold text-slate-950"}>
        {title}
      </h5>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        {body || "この項目は、教材解析を再実行するとより詳しく表示されます。"}
      </p>
    </div>
  );
}

function SavedNotesPanel({ notes }: { notes: StudyNoteExport[] }) {
  return (
    <div className="rounded-2xl border border-white/80 bg-white/88 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
            Saved Notes
          </p>
          <h3 className="mt-1 text-xl font-semibold text-slate-950">
            保存済み解説ノート
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            保存した解説はアプリ内に残り、PDF出力用ページから印刷できます。
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {notes.length}件
        </span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {notes.map((note) => (
          <div key={note.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="line-clamp-2 font-semibold text-slate-950">{note.topicTitle}</p>
            <p className="mt-1 text-xs text-slate-500">
              {new Date(note.createdAt).toLocaleString("ja-JP")}
            </p>
            <div className="mt-3 flex gap-2">
              <a
                href={`/api/study-notes/${note.id}/print`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-teal-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700"
              >
                PDF出力
              </a>
              <a
                href={`/api/study-notes/${note.id}/print`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                表示
              </a>
            </div>
          </div>
        ))}
        {notes.length === 0 && (
          <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
            学習詳細の「解説をアプリに保存」からノートを保存できます。
          </p>
        )}
      </div>
    </div>
  );
}

function StudySettingsForm({
  studyStyle,
  setStudyStyle,
  weekdayMinutes,
  setWeekdayMinutes,
  includeQuiz,
  setIncludeQuiz,
  includeReviewDays,
  setIncludeReviewDays,
  includeAudioLearning,
  setIncludeAudioLearning,
  busy,
  disabled,
  onGenerate,
}: {
  studyStyle: string;
  setStudyStyle: (value: string) => void;
  weekdayMinutes: Record<string, number>;
  setWeekdayMinutes: (value: Record<string, number>) => void;
  includeQuiz: boolean;
  setIncludeQuiz: (value: boolean) => void;
  includeReviewDays: boolean;
  setIncludeReviewDays: (value: boolean) => void;
  includeAudioLearning: boolean;
  setIncludeAudioLearning: (value: boolean) => void;
  busy: string | null;
  disabled: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="rounded-2xl border border-white/80 bg-white/85 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
      <h3 className="text-lg font-semibold text-slate-950">学習計画設定</h3>
      <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1 text-sm">
        {[
          ["exam", "試験対策"],
          ["understand", "理解重視"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setStudyStyle(value)}
            className={`rounded-lg px-3 py-2 font-semibold transition ${
              studyStyle === value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-7 gap-2">
        {weekdayLabels.map((label, index) => (
          <label key={label} className="text-center text-xs font-semibold text-slate-500">
            {label}
            <input
              type="number"
              min="0"
              max="240"
              value={weekdayMinutes[String(index)] ?? 0}
              onChange={(e) =>
                setWeekdayMinutes({
                  ...weekdayMinutes,
                  [String(index)]: Number(e.target.value),
                })
              }
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-1 py-2 text-center text-sm text-slate-900 outline-none focus:border-teal-500"
            />
          </label>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        <Toggle label="クイズ演習を含める" checked={includeQuiz} onChange={setIncludeQuiz} />
        <Toggle
          label="復習日を含める"
          checked={includeReviewDays}
          onChange={setIncludeReviewDays}
        />
        <Toggle
          label="音声教材を聴講タスクにする"
          checked={includeAudioLearning}
          onChange={setIncludeAudioLearning}
        />
      </div>

      <button
        type="button"
        onClick={onGenerate}
        disabled={disabled || busy === "plan"}
        className="mt-5 w-full rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-teal-600/20 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {busy === "plan" ? "生成中..." : "3周学習計画を生成"}
      </button>
    </div>
  );
}

function PlanPreview({
  plan,
  todayTasks,
  progress,
  onToggleTask,
}: {
  plan: GeneratedStudyPlan | null;
  todayTasks: GeneratedStudyPlan["tasks"];
  progress: LearningProgress;
  onToggleTask: (taskKey: string) => void;
}) {
  if (!plan) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-8 text-center text-slate-500">
        解析後に学習計画を生成すると、3周の配分と今日のタスクが表示されます。
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-white/80 bg-white/85 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">3周学習プラン</h3>
            <p className="mt-1 text-sm text-slate-500">
              {plan.summary.totalDays}日 / 合計{plan.summary.totalMinutes}分 / 1日平均
              {plan.summary.dailyAverageMinutes}分
            </p>
          </div>
          <ProgressGauge value={72} />
        </div>
        <div className="mt-5 space-y-3">
          {plan.rounds.map((round) => (
            <div key={round.round} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-slate-950">{round.title}</h4>
                  <p className="mt-1 text-sm text-slate-500">{round.goal}</p>
                </div>
                <span className="rounded-full bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-700">
                  {round.minutes}分
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {round.focus.map((item) => (
                  <span
                    key={item}
                    className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/80 bg-white/85 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <h3 className="text-lg font-semibold text-slate-950">今日のタスク</h3>
          <div className="mt-4 space-y-3">
            {todayTasks.map((task) => {
              const key = taskKey(task);
              const done = progress.completedTasks.includes(key);
              return (
              <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl bg-slate-50 p-4 transition hover:bg-teal-50/60">
                <input
                  type="checkbox"
                  checked={done}
                  onChange={() => onToggleTask(key)}
                  className="mt-1 h-4 w-4 accent-teal-600"
                />
                <span className="min-w-0 flex-1">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                  <span>{task.date}</span>
                  <span>{task.minutes}分</span>
                </div>
                <p className={done ? "mt-1 font-semibold text-slate-400 line-through" : "mt-1 font-semibold text-slate-950"}>{task.title}</p>
                <p className="mt-1 text-sm text-slate-500">{task.materialTitle}</p>
                </span>
              </label>
            );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-white/80 bg-white/85 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <h3 className="text-lg font-semibold text-slate-950">AIからの学習アドバイス</h3>
          <div className="mt-4 space-y-3">
            {plan.advice.map((advice) => (
              <p key={advice} className="rounded-xl bg-teal-50 p-4 text-sm leading-6 text-teal-950">
                {advice}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  dark = false,
}: {
  label: string;
  value: string;
  dark?: boolean;
}) {
  return (
    <div className={dark ? "rounded-lg bg-white/10 p-3" : "rounded-lg bg-slate-50 p-3"}>
      <p className={dark ? "text-[11px] font-semibold text-slate-300" : "text-[11px] font-semibold text-slate-500"}>
        {label}
      </p>
      <p className={dark ? "mt-1 truncate text-sm font-bold text-white" : "mt-1 truncate text-sm font-bold text-slate-950"}>
        {value}
      </p>
    </div>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`h-3 w-3 rounded-full ${done ? "bg-teal-500" : "bg-slate-200"}`} />
      <span className={done ? "text-sm font-semibold text-slate-900" : "text-sm text-slate-500"}>
        {label}
      </span>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-3 text-sm font-semibold text-slate-700">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-teal-600"
      />
    </label>
  );
}

function ProgressGauge({ value }: { value: number }) {
  return (
    <div className="grid h-16 w-16 place-items-center rounded-full bg conic-gradient text-sm font-bold text-teal-900"
      style={{ background: `conic-gradient(#14b8a6 ${value}%, #e2e8f0 0)` }}
    >
      <div className="grid h-12 w-12 place-items-center rounded-full bg-white">{value}%</div>
    </div>
  );
}

function StatusPill({ status }: { status: StudyProject["status"] }) {
  const label =
    status === "learning"
      ? "学習中"
      : status === "analyzed"
        ? "解析済"
        : status === "completed"
          ? "完了"
          : "準備中";
  return (
    <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">
      {label}
    </span>
  );
}

function emptyProgress(): LearningProgress {
  return { completedTopics: [], completedTasks: [] };
}

function toggleItem(items: string[], item: string) {
  return items.includes(item)
    ? items.filter((current) => current !== item)
    : [...items, item];
}

function buildProgressSummary(
  project: ProjectPayload,
  structure: DocumentStructure | null,
  progress: LearningProgress,
): ProgressSummary {
  const plan = project.plan?.plan ?? null;
  const topicKeys = structure ? collectTopicKeys(structure.nodes) : [];
  const totalTopics = topicKeys.length;
  const completedTopics = progress.completedTopics.filter((key) =>
    topicKeys.includes(key),
  ).length;

  if (!plan) {
    const actualPercent = totalTopics
      ? Math.round((completedTopics / totalTopics) * 100)
      : project.materials.length
        ? 8
        : 0;
    return {
      plannedPercent: 0,
      actualPercent,
      plannedMinutes: 0,
      actualMinutes: Math.round(
        ((project.analysis?.estimatedTotalStudyMinutes ?? 0) * actualPercent) / 100,
      ),
      totalMinutes: project.analysis?.estimatedTotalStudyMinutes ?? 0,
      behindMinutes: 0,
      behindDays: 0,
      completedTopics,
      totalTopics,
      completedTasks: 0,
      totalTasks: 0,
      status: actualPercent > 0 ? "on-track" : "not-started",
    };
  }

  const today = startOfToday();
  const elapsedTasks = plan.tasks.filter(
    (task) => new Date(`${task.date}T00:00:00`).getTime() <= today.getTime(),
  );
  const plannedMinutes = elapsedTasks.reduce((sum, task) => sum + task.minutes, 0);
  const totalMinutes = Math.max(1, plan.summary.totalMinutes);
  const completedTasks = plan.tasks.filter((task) =>
    progress.completedTasks.includes(taskKey(task)),
  );
  const taskMinutes = completedTasks.reduce((sum, task) => sum + task.minutes, 0);
  const topicMinutes =
    totalTopics > 0
      ? Math.round((completedTopics / totalTopics) * totalMinutes * 0.25)
      : 0;
  const actualMinutes = Math.min(totalMinutes, taskMinutes + topicMinutes);
  const plannedPercent = clampPercent(Math.round((plannedMinutes / totalMinutes) * 100));
  const actualPercent = clampPercent(Math.round((actualMinutes / totalMinutes) * 100));
  const behindMinutes = Math.max(0, plannedMinutes - actualMinutes);
  const avgDaily = Math.max(1, plan.summary.dailyAverageMinutes);
  const status =
    actualMinutes > plannedMinutes + avgDaily * 0.5
      ? "ahead"
      : behindMinutes > avgDaily * 0.5
        ? "behind"
        : "on-track";

  return {
    plannedPercent,
    actualPercent,
    plannedMinutes,
    actualMinutes,
    totalMinutes,
    behindMinutes,
    behindDays: behindMinutes ? Math.max(1, Math.ceil(behindMinutes / avgDaily)) : 0,
    completedTopics,
    totalTopics,
    completedTasks: completedTasks.length,
    totalTasks: plan.tasks.length,
    status,
  };
}

function taskKey(task: GeneratedStudyPlan["tasks"][number]) {
  return `${task.date}|${task.round}|${task.title}|${task.materialTitle ?? ""}`;
}

function getActionTasks(
  plan: GeneratedStudyPlan | null,
  progress: LearningProgress,
) {
  if (!plan) return [];
  const today = startOfToday().getTime();
  const incomplete = plan.tasks.filter(
    (task) => !progress.completedTasks.includes(taskKey(task)),
  );
  const due = incomplete.filter(
    (task) => new Date(`${task.date}T00:00:00`).getTime() <= today,
  );
  return (due.length > 0 ? due : incomplete).slice(0, 4);
}

function buildRecoveryAdvice(
  summary: ProgressSummary,
  plan: GeneratedStudyPlan | null,
) {
  if (!plan) {
    return "まず学習計画を生成すると、予定との差分とリカバリー案を自動で出せます。";
  }
  if (summary.behindMinutes <= 0) {
    return "予定どおり進んでいます。今日は新しい単元を進めるより、完了済みトピックを1つだけ短く復習すると定着しやすいです。";
  }
  const dailyAdd = Math.ceil(summary.behindMinutes / Math.max(1, 5 - new Date().getDay()));
  const weekendAdd = Math.min(120, Math.max(30, summary.behindMinutes));
  return `現在は約${summary.behindMinutes}分遅れています。平日に1日${dailyAdd}分追加するか、週末に${weekendAdd}分まとめて入れると予定に戻せます。`;
}

function getWeakTopics(
  structure: DocumentStructure | null,
  progress: LearningProgress,
) {
  if (!structure) return [];
  return flattenTopics(structure.nodes).filter(
    (topic) => !progress.completedTopics.includes(topic.key),
  );
}

function flattenTopics(
  nodes: StructureNode[],
  prefix = "",
): Array<{ key: string; title: string; node: StructureNode }> {
  return nodes.flatMap((node, index) => {
    const key = `${prefix}/${index}`;
    return [
      { key, title: node.title, node },
      ...flattenTopics(node.children ?? [], key),
    ];
  });
}

function collectTopicKeys(nodes: StructureNode[], prefix = ""): string[] {
  return nodes.flatMap((node, index) =>
    collectNodeKeys(node, `${prefix}/${index}`),
  );
}

function collectNodeKeys(node: StructureNode, key: string): string[] {
  return [
    key,
    ...(node.children ?? []).flatMap((child, index) =>
      collectNodeKeys(child, `${key}/${index}`),
    ),
  ];
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function totalBytes(materials: ProjectMaterial[]) {
  return materials.reduce((sum, material) => sum + material.fileSizeBytes, 0);
}

function firstTopic(nodes: StructureNode[]): StructureNode | null {
  for (const node of nodes) {
    if ((node.children?.length ?? 0) > 0) {
      const child = firstTopic(node.children ?? []);
      if (child) return child;
    }
    return node;
  }
  return null;
}

function firstTopicKey(nodes: StructureNode[], prefix = ""): string | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const key = `${prefix}/${index}`;
    const node = nodes[index];
    if ((node.children?.length ?? 0) > 0) {
      const childKey = firstTopicKey(node.children ?? [], key);
      if (childKey) return childKey;
    }
    return key;
  }
  return null;
}

function findTopicByKey(nodes: StructureNode[], key: string): StructureNode | null {
  const indexes = key
    .split("/")
    .filter(Boolean)
    .map((part) => Number(part));
  let currentNodes = nodes;
  let current: StructureNode | null = null;
  for (const index of indexes) {
    current = currentNodes[index] ?? null;
    if (!current) return null;
    currentNodes = current.children ?? [];
  }
  return current;
}

function countTopics(nodes: StructureNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + 1 + countTopics(node.children ?? []),
    0,
  );
}

function pickRelatedKeywords(
  topic: StructureNode | null,
  keywords: KeywordEntry[],
) {
  if (!topic) return keywords.slice(0, 4);
  const haystack = [
    topic.title,
    topic.summary,
    topic.learningGoal,
    topic.importance,
    topic.explanation,
    topic.extraKnowledge,
    topic.keyPoint,
  ]
    .filter(Boolean)
    .join(" ");
  const matched = keywords.filter((keyword) => haystack.includes(keyword.term));
  return (matched.length > 0 ? matched : keywords).slice(0, 4);
}

function estimatePageLabel(
  topicKey: string | null,
  materials: ProjectMaterial[],
) {
  const totalPages = materials.reduce((sum, m) => sum + (m.pageCount ?? 0), 0);
  if (totalPages <= 0) {
    const audio = materials.find((m) => m.mediaCategory === "audio");
    if (audio) return `音声 ${formatSeconds(audio.durationSeconds ?? 0)}`;
    return "教材ページ: 推定中";
  }
  const topIndex = Number(topicKey?.split("/").filter(Boolean)[0] ?? 0);
  const chapterCount = Math.max(1, materials.length + 2);
  const start = Math.max(1, Math.floor((totalPages / chapterCount) * topIndex) + 1);
  const end = Math.min(totalPages, start + Math.max(1, Math.ceil(totalPages / chapterCount)) - 1);
  return `推定 p.${start}-${end}`;
}

function buildQuizSeeds(topic: StructureNode) {
  const seeds = [
    topic.learningGoal && `${topic.title}では、何を理解できればよいですか？`,
    topic.importance && `${topic.title}が重要な理由を、身近な例で説明できますか？`,
    topic.keyPoint && `「ここ大事」の内容を一言で言うと何ですか？`,
    topic.explanation && `${topic.title}で間違えやすいポイントはどこですか？`,
  ].filter(Boolean) as string[];
  return seeds.slice(0, 3);
}

function summarizeMaterials(materials: ProjectMaterial[]) {
  const pdf = materials.filter((m) => m.mediaCategory === "pdf").length;
  const word = materials.filter((m) => m.mediaCategory === "word").length;
  const audio = materials.filter((m) => m.mediaCategory === "audio").length;
  return `${pdf}/${word}/${audio}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function defaultTargetDate() {
  const date = new Date();
  date.setDate(date.getDate() + 21);
  return date.toISOString().slice(0, 10);
}
