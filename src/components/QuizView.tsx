"use client";

import { useState } from "react";
import type {
  Difficulty,
  QuestionType,
  SavedQuizQuestion,
} from "@/lib/ai/quiz";
import type { Rating } from "@/lib/srs";

const DIFF_LABEL: Record<Difficulty, string> = {
  easy: "初級",
  medium: "中級",
  hard: "上級",
};

const TYPE_LABEL: Record<QuestionType, string> = {
  boolean: "○×",
  choice: "4 択",
};

const RATING_OPTIONS: {
  value: Rating;
  label: string;
  hint: string;
}[] = [
  { value: "again", label: "もう一度", hint: "10 分後" },
  { value: "hard", label: "難しい", hint: "短め" },
  { value: "good", label: "普通", hint: "標準" },
  { value: "easy", label: "簡単", hint: "長め" },
];

export interface QuestionSource {
  materialTitle?: string | null;
  nodeTitle?: string | null;
  difficulty?: Difficulty;
  sessionType?: QuestionType;
}

interface QuizViewProps {
  questions: SavedQuizQuestion[];
  onRated?: (
    questionId: string,
    rating: Rating,
    selectedIndex: number,
    isCorrect: boolean,
  ) => Promise<void> | void;
}

export function QuizView({ questions, onRated }: QuizViewProps) {
  return (
    <ol className="space-y-4">
      {questions.map((q, i) => (
        <li key={q.id}>
          <QuestionCard
            index={i}
            question={q}
            onRated={
              onRated
                ? (rating, selectedIndex, isCorrect) =>
                    onRated(q.id, rating, selectedIndex, isCorrect)
                : undefined
            }
          />
        </li>
      ))}
    </ol>
  );
}

interface QuestionCardProps {
  index?: number;
  question: SavedQuizQuestion;
  source?: QuestionSource;
  onRated?: (
    rating: Rating,
    selectedIndex: number,
    isCorrect: boolean,
  ) => Promise<void> | void;
}

export function QuestionCard({
  index,
  question,
  source,
  onRated,
}: QuestionCardProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recorded, setRecorded] = useState<Rating | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revealed = selected !== null;
  const isCorrect = selected === question.answer;

  const options =
    question.type === "boolean"
      ? ["○ (正しい)", "× (誤り)"]
      : (question.choices ?? []);

  async function pickRating(rating: Rating) {
    if (selected === null || submitting || recorded !== null) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRated?.(rating, selected, isCorrect);
      setRecorded(rating);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50 dark:bg-zinc-900/50">
      {source && (source.materialTitle || source.nodeTitle) && (
        <p className="text-xs text-zinc-500 mb-2 flex flex-wrap gap-x-1">
          {source.materialTitle && (
            <span>{source.materialTitle}</span>
          )}
          {source.materialTitle && source.nodeTitle && <span>›</span>}
          {source.nodeTitle && <span>{source.nodeTitle}</span>}
          {(source.difficulty || source.sessionType) && (
            <span className="text-zinc-400">
              ·{" "}
              {source.sessionType && TYPE_LABEL[source.sessionType]}
              {source.sessionType && source.difficulty && " · "}
              {source.difficulty && DIFF_LABEL[source.difficulty]}
            </span>
          )}
        </p>
      )}
      <p className="text-sm font-medium mb-3">
        {typeof index === "number" && (
          <span className="text-zinc-500 mr-2">Q{index + 1}.</span>
        )}
        {question.question}
      </p>
      <div className="space-y-1.5">
        {options.map((opt, i) => {
          const isAnswer = i === question.answer;
          const isPicked = selected === i;
          let cls =
            "w-full text-left text-sm px-3 py-1.5 rounded-md border transition-colors";
          if (!revealed) {
            cls +=
              " border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800";
          } else if (isAnswer) {
            cls +=
              " border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
          } else if (isPicked) {
            cls +=
              " border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100";
          } else {
            cls +=
              " border-zinc-300 dark:border-zinc-700 text-zinc-500 opacity-70";
          }
          return (
            <button
              key={i}
              type="button"
              disabled={revealed}
              onClick={() => setSelected(i)}
              className={cls}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {revealed && (
        <div className="mt-3 space-y-3">
          <p
            className={`text-sm font-medium ${
              isCorrect
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-red-700 dark:text-red-300"
            }`}
          >
            {isCorrect ? "正解!" : "不正解"}
          </p>
          <div className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap bg-white dark:bg-zinc-900 rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
            {question.explanation}
          </div>

          {onRated && (
            <div>
              <p className="text-xs text-zinc-500 mb-2">
                手応えで次回の出題タイミングを決めます
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {RATING_OPTIONS.map((r) => {
                  const active = recorded === r.value;
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => pickRating(r.value)}
                      disabled={submitting || recorded !== null}
                      className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                        active
                          ? "bg-zinc-900 text-white border-zinc-900 dark:bg-white dark:text-zinc-900 dark:border-white"
                          : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                      }`}
                    >
                      <span className="block font-medium">{r.label}</span>
                      <span className="block text-[10px] opacity-70">
                        {r.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
              {recorded && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2">
                  記録しました ({RATING_OPTIONS.find((r) => r.value === recorded)?.label})
                </p>
              )}
              {error && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                  {error}
                </p>
              )}
            </div>
          )}

          {!recorded && (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
            >
              もう一度
            </button>
          )}
        </div>
      )}
    </div>
  );
}
