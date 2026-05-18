"use client";

import { useMemo, useState } from "react";
import type {
  Difficulty,
  QuestionType,
  SavedQuizQuestion,
} from "@/lib/ai/quiz";
import type { DocumentStructure } from "@/lib/ai/structure";
import type { Rating } from "@/lib/srs";
import type { AiProvider } from "@/lib/ai/types";
import { resolveScope } from "@/lib/exam-scope";
import { QuestionCard } from "@/components/QuizView";

interface Props {
  structure: DocumentStructure;
  materialId: string | null;
  initialScopeKey: string | null;
  initialScopeTitle: string | null;
  provider: AiProvider;
  onClose: () => void;
}

type Phase = "config" | "loading" | "running" | "summary";

interface AnswerLog {
  questionId: string;
  selectedIndex: number;
  isCorrect: boolean;
  rating: Rating;
}

const DIFF_OPTIONS: { value: Difficulty; label: string }[] = [
  { value: "easy", label: "易" },
  { value: "medium", label: "中" },
  { value: "hard", label: "難" },
];

const COUNT_OPTIONS = [5, 10, 15, 20];

export function ExamMode({
  structure,
  materialId,
  initialScopeKey,
  initialScopeTitle,
  provider,
  onClose,
}: Props) {
  const [phase, setPhase] = useState<Phase>("config");
  const [scopeKey, setScopeKey] = useState<string | null>(
    initialScopeKey,
  );
  const [includeChoice, setIncludeChoice] = useState(true);
  const [includeBoolean, setIncludeBoolean] = useState(true);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [count, setCount] = useState(10);

  const [questions, setQuestions] = useState<SavedQuizQuestion[]>([]);
  const [scopeLabel, setScopeLabel] = useState<string>("");
  const [currentIdx, setCurrentIdx] = useState(0);
  const [logs, setLogs] = useState<AnswerLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wholeScope = useMemo(
    () => resolveScope(structure, null),
    [structure],
  );
  const subtreeScope = useMemo(
    () =>
      initialScopeKey ? resolveScope(structure, initialScopeKey) : null,
    [structure, initialScopeKey],
  );

  async function start() {
    setError(null);
    const types: QuestionType[] = [];
    if (includeChoice) types.push("choice");
    if (includeBoolean) types.push("boolean");
    if (types.length === 0) {
      setError("出題形式を 1 つ以上選んでください");
      return;
    }

    setPhase("loading");
    try {
      const res = await fetch("/api/exam", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          materialId,
          structure,
          scopeNodeKey: scopeKey,
          types,
          difficulty,
          count,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      setQuestions(body.questions as SavedQuizQuestion[]);
      setScopeLabel(body.scopeLabel as string);
      setCurrentIdx(0);
      setLogs([]);
      setPhase("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("config");
    }
  }

  async function onRated(
    questionId: string,
    rating: Rating,
    selectedIndex: number,
    isCorrect: boolean,
  ) {
    const res = await fetch("/api/srs/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId, rating, selectedIndex }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `エラー: ${res.status}`);
    }
    setLogs((prev) => [
      ...prev,
      { questionId, selectedIndex, isCorrect, rating },
    ]);
    await new Promise((r) => setTimeout(r, 700));
    if (currentIdx < questions.length - 1) {
      setCurrentIdx((i) => i + 1);
    } else {
      setPhase("summary");
    }
  }

  function restart() {
    setQuestions([]);
    setLogs([]);
    setCurrentIdx(0);
    setPhase("config");
    setError(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-3xl max-h-[92vh] flex flex-col bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-2xl">
        <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold">総合演習</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            aria-label="閉じる"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {phase === "config" && (
            <ConfigForm
              wholeNodes={wholeScope.nodes.length}
              wholeLabel={structure.title}
              subtreeNodes={subtreeScope?.nodes.length ?? 0}
              subtreeLabel={initialScopeTitle ?? ""}
              hasSubtree={!!initialScopeKey}
              scopeKey={scopeKey}
              setScopeKey={setScopeKey}
              includeChoice={includeChoice}
              setIncludeChoice={setIncludeChoice}
              includeBoolean={includeBoolean}
              setIncludeBoolean={setIncludeBoolean}
              difficulty={difficulty}
              setDifficulty={setDifficulty}
              count={count}
              setCount={setCount}
              onStart={start}
              error={error}
            />
          )}

          {phase === "loading" && (
            <div className="py-16 text-center text-sm text-zinc-500">
              問題を生成しています... ({count} 問)
            </div>
          )}

          {phase === "running" && questions.length > 0 && (
            <RunningView
              questions={questions}
              currentIdx={currentIdx}
              scopeLabel={scopeLabel}
              onRated={onRated}
            />
          )}

          {phase === "summary" && (
            <SummaryView
              questions={questions}
              logs={logs}
              scopeLabel={scopeLabel}
              onRestart={restart}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ConfigForm({
  wholeNodes,
  wholeLabel,
  subtreeNodes,
  subtreeLabel,
  hasSubtree,
  scopeKey,
  setScopeKey,
  includeChoice,
  setIncludeChoice,
  includeBoolean,
  setIncludeBoolean,
  difficulty,
  setDifficulty,
  count,
  setCount,
  onStart,
  error,
}: {
  wholeNodes: number;
  wholeLabel: string;
  subtreeNodes: number;
  subtreeLabel: string;
  hasSubtree: boolean;
  scopeKey: string | null;
  setScopeKey: (k: string | null) => void;
  includeChoice: boolean;
  setIncludeChoice: (v: boolean) => void;
  includeBoolean: boolean;
  setIncludeBoolean: (v: boolean) => void;
  difficulty: Difficulty;
  setDifficulty: (d: Difficulty) => void;
  count: number;
  setCount: (n: number) => void;
  onStart: () => void;
  error: string | null;
}) {
  return (
    <div className="space-y-5">
      <Field label="出題範囲">
        <div className="space-y-1.5">
          <ScopeOption
            active={scopeKey === null}
            onClick={() => setScopeKey(null)}
            title={`教材全体: ${wholeLabel}`}
            subtitle={`${wholeNodes} トピック`}
          />
          {hasSubtree && (
            <ScopeOption
              active={scopeKey !== null}
              onClick={() => setScopeKey(scopeKey ?? null)}
              title={`選択中の枝: ${subtreeLabel}`}
              subtitle={`${subtreeNodes} トピック`}
            />
          )}
        </div>
      </Field>

      <Field label="出題形式 (両方選ぶと混合)">
        <div className="flex gap-2">
          <ToggleChip
            active={includeChoice}
            onClick={() => setIncludeChoice(!includeChoice)}
          >
            4 択
          </ToggleChip>
          <ToggleChip
            active={includeBoolean}
            onClick={() => setIncludeBoolean(!includeBoolean)}
          >
            ○×
          </ToggleChip>
        </div>
      </Field>

      <Field label="難易度">
        <div className="flex gap-2">
          {DIFF_OPTIONS.map((d) => (
            <ToggleChip
              key={d.value}
              active={difficulty === d.value}
              onClick={() => setDifficulty(d.value)}
            >
              {d.label}
            </ToggleChip>
          ))}
        </div>
      </Field>

      <Field label="問題数">
        <div className="flex gap-2">
          {COUNT_OPTIONS.map((n) => (
            <ToggleChip key={n} active={count === n} onClick={() => setCount(n)}>
              {n}
            </ToggleChip>
          ))}
        </div>
      </Field>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="button"
        onClick={onStart}
        className="w-full px-4 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        演習を開始
      </button>
    </div>
  );
}

function RunningView({
  questions,
  currentIdx,
  scopeLabel,
  onRated,
}: {
  questions: SavedQuizQuestion[];
  currentIdx: number;
  scopeLabel: string;
  onRated: (
    questionId: string,
    rating: Rating,
    selectedIndex: number,
    isCorrect: boolean,
  ) => Promise<void>;
}) {
  const q = questions[currentIdx];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {currentIdx + 1} / {questions.length} 問
        </span>
        <span>{scopeLabel}</span>
      </div>
      <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div
          className="bg-zinc-900 dark:bg-white h-full transition-all"
          style={{ width: `${(currentIdx / questions.length) * 100}%` }}
        />
      </div>
      <QuestionCard
        question={q}
        onRated={(rating, selectedIndex, isCorrect) =>
          onRated(q.id, rating, selectedIndex, isCorrect)
        }
      />
    </div>
  );
}

function SummaryView({
  questions,
  logs,
  scopeLabel,
  onRestart,
  onClose,
}: {
  questions: SavedQuizQuestion[];
  logs: AnswerLog[];
  scopeLabel: string;
  onRestart: () => void;
  onClose: () => void;
}) {
  const total = logs.length;
  const correct = logs.filter((l) => l.isCorrect).length;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  const logsById = new Map(logs.map((l) => [l.questionId, l]));

  return (
    <div className="space-y-5">
      <div className="text-center py-4 border border-zinc-200 dark:border-zinc-800 rounded-lg">
        <p className="text-xs text-zinc-500">{scopeLabel}</p>
        <p className="text-4xl font-semibold mt-1">
          {correct} <span className="text-base text-zinc-500">/ {total}</span>
        </p>
        <p className="text-sm text-zinc-500 mt-1">正答率 {pct}%</p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          問題別の結果
        </h3>
        <ol className="space-y-1">
          {questions.map((q, i) => {
            const log = logsById.get(q.id);
            const ok = log?.isCorrect;
            return (
              <li
                key={q.id}
                className={`flex items-start gap-2 text-sm rounded-md border px-3 py-2 ${
                  ok
                    ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40"
                    : "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                }`}
              >
                <span className="text-xs font-medium text-zinc-500 mt-0.5">
                  Q{i + 1}
                </span>
                <span className="flex-1">{q.question}</span>
                <span
                  className={`text-xs font-medium shrink-0 ${
                    ok
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-red-700 dark:text-red-300"
                  }`}
                >
                  {ok ? "正解" : "不正解"}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRestart}
          className="flex-1 px-4 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          もう一度
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-4 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          閉じる
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-1.5">{label}</p>
      {children}
    </div>
  );
}

function ScopeOption({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
        active
          ? "border-zinc-900 dark:border-white bg-zinc-50 dark:bg-zinc-800"
          : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800"
      }`}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
    </button>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
        active
          ? "bg-zinc-900 text-white border-zinc-900 dark:bg-white dark:text-zinc-900 dark:border-white"
          : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}
