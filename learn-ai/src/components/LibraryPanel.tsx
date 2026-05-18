"use client";

import { useEffect, useState } from "react";
import type { Material, MaterialSummary } from "@/lib/library";

interface Props {
  onOpen: (m: Material) => void;
  onClose: () => void;
  refreshKey: number;
}

export function LibraryPanel({ onOpen, onClose, refreshKey }: Props) {
  const [items, setItems] = useState<MaterialSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/library");
        const body = await res.json();
        if (!cancelled) setItems(body.items ?? []);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function open(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/library/${id}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      onOpen(body.material as Material);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("この教材を削除しますか?")) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/library/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `エラー: ${res.status}`);
      }
      setItems((prev) => prev?.filter((x) => x.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/30">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-label="閉じる"
      />
      <aside className="relative w-full max-w-md h-full bg-white dark:bg-zinc-900 shadow-xl border-l border-zinc-200 dark:border-zinc-800 flex flex-col">
        <header className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold">教材ライブラリ</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          {items === null ? (
            <p className="text-sm text-zinc-500">読み込み中...</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-zinc-500">
              保存された教材はまだありません
            </p>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 flex items-start gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{it.title}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {new Date(it.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => open(it.id)}
                    disabled={busyId === it.id}
                    className="px-2.5 py-1 text-xs rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900"
                  >
                    開く
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(it.id)}
                    disabled={busyId === it.id}
                    className="px-2.5 py-1 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                  >
                    削除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
