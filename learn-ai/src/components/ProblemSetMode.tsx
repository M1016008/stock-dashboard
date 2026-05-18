"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import type {
  ProblemRecord,
  ProblemSetDetail,
  ProblemSetSummary,
} from "@/lib/problem-sets";
import type { ProblemAugmentation } from "@/lib/ai/problem-augment";
import type { MaterialSummary } from "@/lib/library";
import type { AiProvider } from "@/lib/ai/types";

interface Props {
  provider: AiProvider;
  setProvider: (p: AiProvider) => void;
}

type View = "list" | "upload" | "detail";

export function ProblemSetMode({ provider, setProvider }: Props) {
  const [view, setView] = useState<View>("list");
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">問題集</h2>
        <div className="flex gap-2">
          {view !== "list" && (
            <button
              type="button"
              onClick={() => {
                setView("list");
                setOpenId(null);
              }}
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
            >
              一覧に戻る
            </button>
          )}
          {view === "list" && (
            <button
              type="button"
              onClick={() => setView("upload")}
              className="px-3 py-1.5 text-sm rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              新規アップロード
            </button>
          )}
        </div>
      </div>

      {view === "list" && (
        <ListView
          onOpen={(id) => {
            setOpenId(id);
            setView("detail");
          }}
        />
      )}
      {view === "upload" && (
        <UploadView
          provider={provider}
          setProvider={setProvider}
          onCreated={(id) => {
            setOpenId(id);
            setView("detail");
          }}
        />
      )}
      {view === "detail" && openId && (
        <DetailView
          id={openId}
          provider={provider}
          onDeleted={() => {
            setOpenId(null);
            setView("list");
          }}
        />
      )}
    </div>
  );
}

function ListView({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<ProblemSetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/problem-sets");
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
        if (!cancelled) setItems(body.items ?? []);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-red-200 dark:border-red-900 p-5 text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    );
  }
  if (items === null) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
        読み込み中...
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
        まだ問題集がありません。「新規アップロード」から PDF をアップロードしてください。
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li
          key={it.id}
          className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 flex items-center gap-3"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{it.title}</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {it.problemCount} 問 · AI 補足 {it.augmentedCount}/
              {it.problemCount}
              {it.materialTitle && (
                <span className="ml-2">テキスト連携: {it.materialTitle}</span>
              )}
            </p>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              {new Date(it.createdAt).toLocaleString()}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpen(it.id)}
            className="px-3 py-1.5 text-sm rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 shrink-0"
          >
            開く
          </button>
        </li>
      ))}
    </ul>
  );
}

function UploadView({
  provider,
  setProvider,
  onCreated,
}: {
  provider: AiProvider;
  setProvider: (p: AiProvider) => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [materialId, setMaterialId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/library");
        const body = await res.json();
        setMaterials(body.items ?? []);
      } catch {
        // ignore
      }
    })();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() && !file) {
      setError("問題集のテキストまたはファイルを入力してください");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("provider", provider);
      if (title.trim()) form.append("title", title.trim());
      if (materialId) form.append("materialId", materialId);
      if (text.trim()) form.append("text", text.trim());
      if (file) form.append("file", file);

      const res = await fetch("/api/problem-sets", {
        method: "POST",
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      onCreated(body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-4"
    >
      <div>
        <label className="block text-xs text-zinc-500 mb-1">タイトル (任意)</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="自動抽出のタイトルを上書きしたい場合に入力"
          className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-500 mb-1">
          連携するテキスト (任意。本文と紐付けて補足解説の精度を上げる)
        </label>
        <select
          value={materialId}
          onChange={(e) => setMaterialId(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950"
        >
          <option value="">なし (問題集のみで補足生成)</option>
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-zinc-500 mb-1">AI プロバイダー</label>
        <div className="flex gap-2">
          {(["anthropic", "openai"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className={`px-3 py-1.5 text-sm rounded-md border ${
                provider === p
                  ? "bg-zinc-900 text-white border-zinc-900 dark:bg-white dark:text-zinc-900 dark:border-white"
                  : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {p === "anthropic" ? "Claude" : "GPT (OpenAI)"}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs text-zinc-500 mb-1">問題集テキスト</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="問題集の本文を貼り付け (または下からファイル選択)"
          className="w-full h-40 px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
      </div>

      <div>
        <label className="block text-xs text-zinc-500 mb-1">
          またはファイル (.pdf / .txt / .md)
        </label>
        <input
          type="file"
          accept=".pdf,.txt,.md,application/pdf,text/plain"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-zinc-300 file:bg-zinc-50 hover:file:bg-zinc-100 dark:file:border-zinc-700 dark:file:bg-zinc-800"
        />
        {file && (
          <p className="mt-1 text-xs text-zinc-500">
            {file.name} ({Math.round(file.size / 1024)} KB)
          </p>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full px-4 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {loading ? "問題を抽出中..." : "アップロード & 抽出"}
      </button>
    </form>
  );
}

function DetailView({
  id,
  provider,
  onDeleted,
}: {
  id: string;
  provider: AiProvider;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<ProblemSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/problem-sets/${id}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      setDetail(body.problemSet as ProblemSetDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onDelete() {
    if (!confirm("この問題集を削除しますか?")) return;
    try {
      const res = await fetch(`/api/problem-sets/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `エラー: ${res.status}`);
      }
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function updateProblem(updated: ProblemRecord) {
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            problems: prev.problems.map((p) =>
              p.id === updated.id ? updated : p,
            ),
          }
        : prev,
    );
  }

  if (error) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-red-200 dark:border-red-900 p-5 text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
        読み込み中...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold">{detail.title}</h3>
          <p className="text-xs text-zinc-500 mt-1">
            {detail.problems.length} 問
            {detail.materialTitle && (
              <span className="ml-2">
                · テキスト連携: {detail.materialTitle}
              </span>
            )}
            <span className="ml-2">
              · {new Date(detail.createdAt).toLocaleString()}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="px-2.5 py-1 text-xs rounded-md border border-red-300 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950"
        >
          削除
        </button>
      </div>

      <ul className="space-y-3">
        {detail.problems.map((p) => (
          <li key={p.id}>
            <ProblemCard
              problem={p}
              problemSetId={id}
              hasTextbook={!!detail.materialId}
              provider={provider}
              onUpdated={updateProblem}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProblemCard({
  problem,
  problemSetId,
  hasTextbook,
  provider,
  onUpdated,
}: {
  problem: ProblemRecord;
  problemSetId: string;
  hasTextbook: boolean;
  provider: AiProvider;
  onUpdated: (p: ProblemRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [augmenting, setAugmenting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAugmentation() {
    setAugmenting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/problem-sets/${problemSetId}/augment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            problemIndex: problem.problemIndex,
            provider,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      onUpdated({
        ...problem,
        augmentation: body.augmentation as ProblemAugmentation,
        augmentedAt: Date.now(),
      });
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAugmenting(false);
    }
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
      <div>
        <p className="text-sm font-medium">
          <span className="text-zinc-500 mr-2">
            {problem.numberLabel ?? `Q${problem.problemIndex + 1}`}
          </span>
          {problem.questionText}
        </p>
        {problem.choices && problem.choices.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
            {problem.choices.map((c, i) => (
              <li key={i} className="pl-3">
                {c}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(problem.answerText || problem.originalExplanation) && (
        <details className="rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2" open>
          <summary className="text-xs font-medium text-zinc-700 dark:text-zinc-300 cursor-pointer">
            問題集の解説
          </summary>
          <div className="mt-2 space-y-2">
            {problem.answerText && (
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                {problem.answerText}
              </p>
            )}
            {problem.originalExplanation && (
              <p className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                {problem.originalExplanation}
              </p>
            )}
          </div>
        </details>
      )}

      <div>
        {problem.augmentation ? (
          <div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
            >
              {expanded ? "AI 補足を閉じる" : "AI 補足を表示"}
            </button>
            {expanded && (
              <AugmentationView
                augmentation={problem.augmentation}
                hasTextbook={hasTextbook}
              />
            )}
            <button
              type="button"
              onClick={loadAugmentation}
              disabled={augmenting}
              className="ml-3 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 underline disabled:opacity-50"
            >
              {augmenting ? "再生成中..." : "AI 補足を再生成"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={loadAugmentation}
            disabled={augmenting}
            className="px-3 py-1.5 text-xs rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {augmenting ? "AI 補足を生成中..." : "AI 補足を生成"}
          </button>
        )}
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>
        )}
      </div>
    </div>
  );
}

function AugmentationView({
  augmentation,
  hasTextbook,
}: {
  augmentation: ProblemAugmentation;
  hasTextbook: boolean;
}) {
  const sections: { label: string; body: string; tone?: "primary" }[] = [
    { label: "ポイント", body: augmentation.keyPoint, tone: "primary" },
    { label: "なぜその解答になるのか", body: augmentation.reasoning },
  ];
  if (hasTextbook && augmentation.textbookReference) {
    sections.push({
      label: "関連するテキスト本文の該当箇所",
      body: augmentation.textbookReference,
    });
  }
  if (hasTextbook && augmentation.connection) {
    sections.push({
      label: "テキスト内容とのつながり",
      body: augmentation.connection,
    });
  }
  sections.push({
    label: "初学者向けの追加説明",
    body: augmentation.beginnerNotes,
  });

  return (
    <div className="mt-3 space-y-3 bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800 rounded-md p-4">
      {sections.map((s) => (
        <div key={s.label}>
          <p
            className={`text-xs font-medium mb-1 ${
              s.tone === "primary"
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-zinc-600 dark:text-zinc-400"
            }`}
          >
            【{s.label}】
          </p>
          <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap">
            {s.body}
          </p>
        </div>
      ))}
    </div>
  );
}
