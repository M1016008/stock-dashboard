"use client";

import { useCallback, useEffect, useState } from "react";
import type { DueCard, Rating, SrsStats } from "@/lib/srs";
import { QuestionCard } from "@/components/QuizView";
import type { SavedQuizQuestion } from "@/lib/ai/quiz";

export function ReviewMode() {
  const [stats, setStats] = useState<SrsStats | null>(null);
  const [cards, setCards] = useState<DueCard[] | null>(null);
  const [index, setIndex] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/srs/stats");
      const body = await res.json();
      setStats(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  async function startReview() {
    setError(null);
    try {
      const res = await fetch("/api/srs/due?limit=50");
      const body = await res.json();
      const due = (body.cards as DueCard[]) ?? [];
      if (due.length === 0) {
        setError("いま復習すべきカードはありません");
        return;
      }
      setCards(due);
      setIndex(0);
      setReviewing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRated(
    questionId: string,
    rating: Rating,
    selectedIndex: number,
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
    // brief pause so the user can read the result before advancing
    await new Promise((r) => setTimeout(r, 800));
    if (cards && index < cards.length - 1) {
      setIndex((i) => i + 1);
    } else {
      setReviewing(false);
      setCards(null);
      await loadStats();
    }
  }

  if (reviewing && cards) {
    const card = cards[index];
    const saved: SavedQuizQuestion = {
      id: card.question.id,
      type: card.question.type,
      question: card.question.question,
      choices: card.question.choices ?? undefined,
      answer: card.question.answer,
      explanation: card.question.explanation,
    };
    return (
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>
            {index + 1} / {cards.length} 問
          </span>
          <button
            type="button"
            onClick={() => {
              setReviewing(false);
              setCards(null);
              void loadStats();
            }}
            className="hover:text-zinc-900 dark:hover:text-zinc-100 underline"
          >
            復習を終わる
          </button>
        </div>
        <QuestionCard
          question={saved}
          source={{
            materialTitle: card.source.materialTitle,
            nodeTitle: card.source.nodeTitle,
            difficulty: card.source.difficulty,
            sessionType: card.source.sessionType,
          }}
          onRated={(rating, selectedIndex) =>
            onRated(card.question.id, rating, selectedIndex)
          }
        />
      </section>
    );
  }

  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-5">
      <div>
        <h2 className="text-base font-semibold mb-1">復習</h2>
        <p className="text-xs text-zinc-500">
          解いた問題を時間を置いて再出題します。手応えに応じて次の出題時期が決まります。
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="いま復習可" value={stats?.dueNow ?? "–"} accent />
        <StatTile label="今日中に復習" value={stats?.dueToday ?? "–"} />
        <StatTile label="カード総数" value={stats?.totalCards ?? "–"} />
        <StatTile
          label="今日の正答"
          value={
            stats
              ? `${stats.correctToday} / ${stats.reviewedToday}`
              : "–"
          }
        />
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="button"
        onClick={startReview}
        disabled={!stats || stats.dueNow === 0}
        className="w-full px-4 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {stats && stats.dueNow > 0
          ? `復習を始める (${stats.dueNow} 問)`
          : "復習待ちのカードはありません"}
      </button>

      <p className="text-xs text-zinc-500">
        ヒント: 構造化モードで問題を生成して「手応え」を選ぶと、そのカードが SRS
        に登録されます。
      </p>
    </section>
  );
}

function StatTile({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        accent
          ? "border-zinc-900 dark:border-white"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <p className="text-xs text-zinc-500">{label}</p>
      <p
        className={`text-xl font-semibold mt-0.5 ${
          accent ? "text-zinc-900 dark:text-white" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}
