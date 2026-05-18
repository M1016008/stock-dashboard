"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  DailyStat,
  DifficultyStat,
  HistoryOverview,
  HistoryReport,
  MaterialStat,
  NodeStat,
  SessionStat,
  TypeStat,
} from "@/lib/history";
import type { Difficulty, QuestionType } from "@/lib/ai/quiz";

interface Props {
  onOpenMaterialById: (id: string) => void;
  refreshKey?: number;
}

const DIFF_LABEL: Record<Difficulty, string> = {
  easy: "初級",
  medium: "中級",
  hard: "上級",
};

const TYPE_LABEL: Record<QuestionType, string> = {
  boolean: "○×",
  choice: "4 択",
};

function accuracyTextColor(acc: number): string {
  if (acc >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (acc >= 0.6) return "text-blue-600 dark:text-blue-400";
  if (acc >= 0.4) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function accuracyBg(acc: number): string {
  if (acc >= 0.8) return "bg-emerald-500";
  if (acc >= 0.6) return "bg-blue-500";
  if (acc >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min} 分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 時間前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 日前`;
  return new Date(ts).toLocaleDateString();
}

export function HistoryMode({ onOpenMaterialById, refreshKey = 0 }: Props) {
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tz = -new Date().getTimezoneOffset();
      const res = await fetch(`/api/history?tzOffset=${tz}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      setReport(body as HistoryReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (loading && !report) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
        集計中...
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    );
  }
  if (!report) return null;

  const isEmpty = report.overview.totalAnswers === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">学習履歴</h2>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
        >
          再読み込み
        </button>
      </div>

      {isEmpty ? (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
          まだ解答記録がありません。構造化モードで問題を生成して手応えを記録すると、ここに学習履歴が表示されます。
        </div>
      ) : (
        <>
          <OverviewSection overview={report.overview} />
          <TrendSection trend={report.trend} />
          <WeakestSection
            nodes={report.weakestNodes}
            onOpen={onOpenMaterialById}
          />
          <BreakdownSection
            byType={report.byType}
            byDifficulty={report.byDifficulty}
          />
          <MaterialSection
            materials={report.byMaterial}
            onOpen={onOpenMaterialById}
          />
          <SessionsSection sessions={report.recentSessions} />
        </>
      )}
    </div>
  );
}

function Card({
  title,
  children,
  action,
}: {
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-3">
      {(title || action) && (
        <div className="flex items-center justify-between">
          {title && <h3 className="text-sm font-medium">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function OverviewSection({ overview }: { overview: HistoryOverview }) {
  return (
    <Card>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatTile
          label="累計解答"
          value={overview.totalAnswers.toString()}
        />
        <StatTile
          label="正答率"
          value={pct(overview.accuracy)}
          accent={accuracyTextColor(overview.accuracy)}
        />
        <StatTile
          label="正解数"
          value={`${overview.correctAnswers}`}
          sub={`/ ${overview.totalAnswers}`}
        />
        <StatTile label="学習日数" value={`${overview.studyDays} 日`} />
        <StatTile
          label="連続学習"
          value={`${overview.currentStreak} 日`}
          sub={`最長 ${overview.longestStreak} 日`}
          accent={
            overview.currentStreak > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : undefined
          }
        />
      </div>
    </Card>
  );
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-semibold mt-0.5 ${accent ?? ""}`}>
        {value}{" "}
        {sub && (
          <span className="text-xs text-zinc-500 font-normal">{sub}</span>
        )}
      </p>
    </div>
  );
}

function TrendSection({ trend }: { trend: DailyStat[] }) {
  const max = Math.max(1, ...trend.map((t) => t.answered));
  const W = 600;
  const H = 90;
  const gap = 2;
  const barW = (W - gap * (trend.length - 1)) / trend.length;

  const total = trend.reduce((s, d) => s + d.answered, 0);
  const correct = trend.reduce((s, d) => s + d.correct, 0);

  return (
    <Card
      title="過去 30 日の学習量"
      action={
        <span className="text-xs text-zinc-500">
          {correct}/{total} 正解
        </span>
      }
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-24"
        role="img"
        aria-label="日別の解答数 (緑=正解 赤=不正解)"
      >
        {trend.map((d, i) => {
          const x = i * (barW + gap);
          const totalH = (d.answered / max) * H;
          const correctH = d.answered > 0 ? (d.correct / d.answered) * totalH : 0;
          const wrongH = totalH - correctH;
          return (
            <g key={d.day}>
              <title>{`${d.day}: ${d.correct}/${d.answered} 正解`}</title>
              {wrongH > 0 && (
                <rect
                  x={x}
                  y={H - totalH}
                  width={barW}
                  height={wrongH}
                  className="fill-red-300 dark:fill-red-900"
                />
              )}
              {correctH > 0 && (
                <rect
                  x={x}
                  y={H - correctH}
                  width={barW}
                  height={correctH}
                  className="fill-emerald-400 dark:fill-emerald-600"
                />
              )}
              {totalH === 0 && (
                <rect
                  x={x}
                  y={H - 1}
                  width={barW}
                  height={1}
                  className="fill-zinc-200 dark:fill-zinc-700"
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>{trend[0]?.day}</span>
        <span>{trend[Math.floor(trend.length / 2)]?.day}</span>
        <span>{trend[trend.length - 1]?.day}</span>
      </div>
      <div className="flex gap-3 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 bg-emerald-400 rounded" />
          正解
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 bg-red-300 rounded" />
          不正解
        </span>
      </div>
    </Card>
  );
}

function WeakestSection({
  nodes,
  onOpen,
}: {
  nodes: NodeStat[];
  onOpen: (id: string) => void;
}) {
  return (
    <Card title="弱点トピック">
      {nodes.length === 0 ? (
        <p className="text-xs text-zinc-500">
          まだ十分なデータがありません
        </p>
      ) : (
        <ul className="space-y-2">
          {nodes.map((n, i) => (
            <li
              key={`${n.materialId}-${n.nodeKey}-${i}`}
              className="flex items-center gap-3 rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {n.nodeTitle}
                </p>
                <p className="text-xs text-zinc-500 truncate">
                  {n.materialTitle ?? "(ライブラリ未保存)"}
                </p>
              </div>
              <div className="w-32 shrink-0">
                <div className="flex items-baseline justify-between">
                  <span
                    className={`text-sm font-medium ${accuracyTextColor(
                      n.accuracy,
                    )}`}
                  >
                    {pct(n.accuracy)}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {n.correct}/{n.answered}
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden mt-1">
                  <div
                    className={`h-full ${accuracyBg(n.accuracy)}`}
                    style={{ width: `${n.accuracy * 100}%` }}
                  />
                </div>
              </div>
              {n.materialId && (
                <button
                  type="button"
                  onClick={() => onOpen(n.materialId!)}
                  className="px-2 py-1 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 shrink-0"
                >
                  教材を開く
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BreakdownSection({
  byType,
  byDifficulty,
}: {
  byType: TypeStat[];
  byDifficulty: DifficultyStat[];
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Card title="出題形式別">
        {byType.length === 0 ? (
          <p className="text-xs text-zinc-500">データ無し</p>
        ) : (
          <ul className="space-y-2">
            {byType.map((s) => (
              <BreakdownRow
                key={s.type}
                label={TYPE_LABEL[s.type]}
                acc={s.accuracy}
                answered={s.answered}
                correct={s.correct}
              />
            ))}
          </ul>
        )}
      </Card>
      <Card title="難易度別">
        {byDifficulty.length === 0 ? (
          <p className="text-xs text-zinc-500">データ無し</p>
        ) : (
          <ul className="space-y-2">
            {byDifficulty.map((s) => (
              <BreakdownRow
                key={s.difficulty}
                label={DIFF_LABEL[s.difficulty]}
                acc={s.accuracy}
                answered={s.answered}
                correct={s.correct}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function BreakdownRow({
  label,
  acc,
  answered,
  correct,
}: {
  label: string;
  acc: number;
  answered: number;
  correct: number;
}) {
  return (
    <li className="flex items-center gap-3">
      <span className="w-12 text-sm font-medium shrink-0">{label}</span>
      <div className="flex-1">
        <div className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full ${accuracyBg(acc)}`}
            style={{ width: `${acc * 100}%` }}
          />
        </div>
      </div>
      <span
        className={`text-sm font-medium w-12 text-right ${accuracyTextColor(
          acc,
        )}`}
      >
        {pct(acc)}
      </span>
      <span className="text-[10px] text-zinc-500 w-16 text-right">
        {correct}/{answered}
      </span>
    </li>
  );
}

function MaterialSection({
  materials,
  onOpen,
}: {
  materials: MaterialStat[];
  onOpen: (id: string) => void;
}) {
  return (
    <Card title="教材別の習熟度">
      {materials.length === 0 ? (
        <p className="text-xs text-zinc-500">データ無し</p>
      ) : (
        <ul className="space-y-2">
          {materials.map((m, i) => (
            <li
              key={`${m.materialId ?? "orphan"}-${i}`}
              className="flex items-center gap-3 rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {m.materialTitle ?? "(ライブラリ未保存)"}
                </p>
              </div>
              <div className="w-40 shrink-0">
                <div className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${accuracyBg(m.accuracy)}`}
                    style={{ width: `${m.accuracy * 100}%` }}
                  />
                </div>
              </div>
              <span
                className={`text-sm font-medium w-12 text-right ${accuracyTextColor(
                  m.accuracy,
                )}`}
              >
                {pct(m.accuracy)}
              </span>
              <span className="text-[10px] text-zinc-500 w-16 text-right">
                {m.correct}/{m.answered}
              </span>
              {m.materialId && (
                <button
                  type="button"
                  onClick={() => onOpen(m.materialId!)}
                  className="px-2 py-1 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 shrink-0"
                >
                  開く
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SessionsSection({ sessions }: { sessions: SessionStat[] }) {
  return (
    <Card title="最近のセッション">
      {sessions.length === 0 ? (
        <p className="text-xs text-zinc-500">データ無し</p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => {
            const acc = s.answered > 0 ? s.correct / s.answered : 0;
            return (
              <li
                key={s.sessionId}
                className="flex items-center gap-3 rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">
                    {s.materialTitle ?? "(ライブラリ未保存)"}
                    {s.nodeTitle && (
                      <span className="text-zinc-500"> › {s.nodeTitle}</span>
                    )}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {TYPE_LABEL[s.type]} · {DIFF_LABEL[s.difficulty]} ·{" "}
                    {formatRelative(s.createdAt)}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p
                    className={`text-sm font-medium ${accuracyTextColor(acc)}`}
                  >
                    {s.correct}/{s.answered}
                  </p>
                  <p className="text-[10px] text-zinc-500">{pct(acc)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
