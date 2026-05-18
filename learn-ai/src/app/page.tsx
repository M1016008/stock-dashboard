"use client";

import { useState, useRef, FormEvent } from "react";
import type { AiProvider } from "@/lib/ai/types";
import type {
  DocumentStructure,
  StructureNode,
} from "@/lib/ai/structure";
import type {
  Difficulty,
  QuestionType,
  SavedQuizQuestion,
} from "@/lib/ai/quiz";
import type { Rating } from "@/lib/srs";
import type { Material } from "@/lib/library";
import { StructureTree } from "@/components/StructureTree";
import { QuizView } from "@/components/QuizView";
import { LibraryPanel } from "@/components/LibraryPanel";
import { ReviewMode } from "@/components/ReviewMode";
import { ExamMode } from "@/components/ExamMode";
import { HistoryMode } from "@/components/HistoryMode";
import { ProblemSetMode } from "@/components/ProblemSetMode";

type Mode =
  | "explain"
  | "structure"
  | "review"
  | "history"
  | "problem-sets";
type NodeTab = "explain" | "quiz";

export default function Home() {
  const [mode, setMode] = useState<Mode>("explain");
  const [provider, setProvider] = useState<AiProvider>("anthropic");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [output, setOutput] = useState("");
  const [structure, setStructure] = useState<DocumentStructure | null>(null);
  const [structureSource, setStructureSource] = useState<string>("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [savingLibrary, setSavingLibrary] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [examOpen, setExamOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<StructureNode | null>(null);
  const [nodeExplain, setNodeExplain] = useState("");
  const [nodeTitle, setNodeTitle] = useState("");
  const [nodeTab, setNodeTab] = useState<NodeTab>("explain");

  const [quizType, setQuizType] = useState<QuestionType>("choice");
  const [quizDifficulty, setQuizDifficulty] = useState<Difficulty>("medium");
  const [quizCount, setQuizCount] = useState(5);
  const [quizQuestions, setQuizQuestions] = useState<SavedQuizQuestion[]>([]);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [nodeLoading, setNodeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nodeAbortRef = useRef<AbortController | null>(null);
  const quizAbortRef = useRef<AbortController | null>(null);

  function reset() {
    setOutput("");
    setStructure(null);
    setStructureSource("");
    setSelectedKey(null);
    setSelectedNode(null);
    setNodeExplain("");
    setNodeTitle("");
    setNodeTab("explain");
    setQuizQuestions([]);
    setQuizError(null);
    setSavedId(null);
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    reset();

    const hasText = text.trim().length > 0;
    const hasFile = file !== null;
    if (!hasText && !hasFile) {
      setError("テキストを入力するか、ファイルを選んでください");
      return;
    }

    const form = new FormData();
    form.append("provider", provider);
    if (hasText) form.append("text", text);
    if (hasFile) form.append("file", file);

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    try {
      if (mode === "explain") {
        await runExplain(form, ctrl);
      } else {
        await runAnalyze(form, ctrl);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function runExplain(form: FormData, ctrl: AbortController) {
    const res = await fetch("/api/explain", {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `エラー: ${res.status}`);
    }
    if (!res.body) throw new Error("レスポンスが空です");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      setOutput((prev) => prev + decoder.decode(value, { stream: true }));
    }
  }

  async function runAnalyze(form: FormData, ctrl: AbortController) {
    const res = await fetch("/api/analyze", {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error ?? `エラー: ${res.status}`);
    }
    setStructure(body.structure as DocumentStructure);
    setStructureSource(
      typeof body.sourceText === "string" ? body.sourceText : "",
    );
  }

  async function saveCurrentToLibrary() {
    if (!structure) return;
    setSavingLibrary(true);
    setError(null);
    try {
      const res = await fetch("/api/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: structure.title,
          originalText: structureSource,
          structure,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      setSavedId(body.material.id);
      setLibraryRefresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLibrary(false);
    }
  }

  function openMaterial(m: Material) {
    setMode("structure");
    reset();
    setStructure(m.structure);
    setStructureSource(m.originalText);
    setSavedId(m.id);
    setLibraryOpen(false);
  }

  async function openMaterialById(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/library/${id}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `エラー: ${res.status}`);
      openMaterial(body.material as Material);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function nodeContent(node: StructureNode): string {
    const parts = [
      node.summary && `【概要】${node.summary}`,
      node.excerpt && `【原文抜粋】${node.excerpt}`,
    ].filter(Boolean);
    return parts.join("\n\n");
  }

  async function onSelectNode(node: StructureNode, key: string) {
    setSelectedKey(key);
    setSelectedNode(node);
    setNodeTitle(node.title);
    setNodeExplain("");
    setQuizQuestions([]);
    setQuizError(null);

    if (nodeTab === "explain") {
      await runNodeExplain(node);
    }
  }

  async function runNodeExplain(node: StructureNode) {
    const content = nodeContent(node);
    if (!content) {
      setNodeExplain("(このノードには抜粋情報がありません)");
      return;
    }

    nodeAbortRef.current?.abort();
    const ctrl = new AbortController();
    nodeAbortRef.current = ctrl;
    setNodeLoading(true);
    setNodeExplain("");

    const form = new FormData();
    form.append("provider", provider);
    form.append("text", `${node.title}\n\n${content}`);

    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        body: form,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `エラー: ${res.status}`);
      }
      if (!res.body) throw new Error("レスポンスが空です");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setNodeExplain((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setNodeExplain(
        `[エラー] ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setNodeLoading(false);
    }
  }

  async function onGenerateQuiz() {
    if (!selectedNode) return;
    const content = nodeContent(selectedNode);
    if (!content) {
      setQuizError("このノードには出題に使える情報がありません");
      return;
    }

    quizAbortRef.current?.abort();
    const ctrl = new AbortController();
    quizAbortRef.current = ctrl;
    setQuizLoading(true);
    setQuizError(null);
    setQuizQuestions([]);

    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          provider,
          text: `${selectedNode.title}\n\n${content}`,
          type: quizType,
          difficulty: quizDifficulty,
          count: quizCount,
          materialId: savedId,
          nodeKey: selectedKey,
          nodeTitle: selectedNode.title,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? `エラー: ${res.status}`);
      }
      setQuizQuestions(body.questions ?? []);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setQuizError(err instanceof Error ? err.message : String(err));
    } finally {
      setQuizLoading(false);
    }
  }

  async function onRateQuestion(
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
  }

  function onQuizRated(
    questionId: string,
    rating: Rating,
    selectedIndex: number,
  ): Promise<void> {
    return onRateQuestion(questionId, rating, selectedIndex);
  }

  function onChangeNodeTab(tab: NodeTab) {
    setNodeTab(tab);
    if (
      tab === "explain" &&
      selectedNode &&
      !nodeExplain &&
      !nodeLoading
    ) {
      void runNodeExplain(selectedNode);
    }
  }

  function onStop() {
    abortRef.current?.abort();
    setLoading(false);
  }

  return (
    <div className="min-h-full flex flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">
            AI 学習プラットフォーム
          </h1>
          <div className="flex items-center gap-3">
            <div className="flex gap-1 text-sm bg-zinc-100 dark:bg-zinc-800 rounded-md p-0.5 flex-wrap">
              {(
                [
                  "explain",
                  "structure",
                  "problem-sets",
                  "review",
                  "history",
                ] as const
              ).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    if (m === "explain" || m === "structure") reset();
                  }}
                  className={`px-3 py-1 rounded ${
                    mode === m
                      ? "bg-white dark:bg-zinc-900 shadow-sm font-medium"
                      : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                  }`}
                >
                  {m === "explain"
                    ? "解説"
                    : m === "structure"
                      ? "構造化"
                      : m === "problem-sets"
                        ? "問題集"
                        : m === "review"
                          ? "復習"
                          : "履歴"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setLibraryOpen(true)}
              className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              ライブラリ
            </button>
          </div>
        </div>
      </header>

      <main
        className={`flex-1 max-w-6xl w-full mx-auto px-6 py-8 ${
          mode === "review" ||
          mode === "history" ||
          mode === "problem-sets"
            ? ""
            : "grid grid-cols-1 lg:grid-cols-2 gap-6"
        }`}
      >
        {mode === "review" && <ReviewMode />}
        {mode === "history" && (
          <HistoryMode onOpenMaterialById={openMaterialById} />
        )}
        {mode === "problem-sets" && (
          <ProblemSetMode provider={provider} setProvider={setProvider} />
        )}
        {mode !== "review" &&
          mode !== "history" &&
          mode !== "problem-sets" && (
          <>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 h-fit"
        >
          <div>
            <label className="block text-sm font-medium mb-2">
              AI プロバイダー
            </label>
            <div className="flex gap-2">
              {(["anthropic", "openai"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
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
            <label className="block text-sm font-medium mb-2">
              教材テキスト
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                mode === "explain"
                  ? "解説してほしい内容を貼り付けてください"
                  : "ツリー構造を抽出したい教材を貼り付けてください"
              }
              className="w-full h-40 px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
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

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {loading
                ? mode === "explain"
                  ? "解説中..."
                  : "解析中..."
                : mode === "explain"
                  ? "解説する"
                  : "構造化する"}
            </button>
            {loading && (
              <button
                type="button"
                onClick={onStop}
                className="px-4 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                停止
              </button>
            )}
          </div>
        </form>

        {mode === "explain" ? (
          <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
            <h2 className="text-sm font-medium mb-3 text-zinc-700 dark:text-zinc-300">
              AI による解説
            </h2>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200 min-h-[24rem]">
              {output ||
                (loading ? (
                  <span className="text-zinc-400">生成中...</span>
                ) : (
                  <span className="text-zinc-400">
                    左に教材を入力して「解説する」を押してください
                  </span>
                ))}
            </div>
          </section>
        ) : (
          <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
            {!structure ? (
              <div className="text-sm text-zinc-400 min-h-[24rem] flex items-center justify-center">
                {loading
                  ? "教材を解析中..."
                  : "左に教材を入力して「構造化する」を押してください"}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">{structure.title}</h2>
                  <div className="flex items-center gap-2">
                    {savedId && (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">
                        保存済み
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={saveCurrentToLibrary}
                      disabled={savingLibrary || !structureSource}
                      className="px-2.5 py-1 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {savingLibrary
                        ? "保存中..."
                        : savedId
                          ? "再保存"
                          : "ライブラリに保存"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setExamOpen(true)}
                      className="px-2.5 py-1 text-xs rounded-md bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                    >
                      総合演習
                    </button>
                  </div>
                </div>
                <StructureTree
                  nodes={structure.nodes}
                  onSelect={onSelectNode}
                  selectedKey={selectedKey}
                />
                {selectedKey && (
                  <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        「{nodeTitle}」
                      </h3>
                      <div className="flex gap-1 text-xs bg-zinc-100 dark:bg-zinc-800 rounded-md p-0.5">
                        {(["explain", "quiz"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => onChangeNodeTab(t)}
                            className={`px-2.5 py-1 rounded ${
                              nodeTab === t
                                ? "bg-white dark:bg-zinc-900 shadow-sm font-medium"
                                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                            }`}
                          >
                            {t === "explain" ? "解説" : "問題"}
                          </button>
                        ))}
                      </div>
                    </div>

                    {nodeTab === "explain" ? (
                      <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200 min-h-[8rem]">
                        {nodeExplain ||
                          (nodeLoading ? (
                            <span className="text-zinc-400">生成中...</span>
                          ) : (
                            <span className="text-zinc-400">
                              ノードをクリックすると解説を生成します
                            </span>
                          ))}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="grid grid-cols-3 gap-2">
                          <ControlGroup label="形式">
                            {(
                              [
                                ["choice", "4 択"],
                                ["boolean", "○×"],
                              ] as const
                            ).map(([v, l]) => (
                              <PillButton
                                key={v}
                                active={quizType === v}
                                onClick={() => setQuizType(v)}
                              >
                                {l}
                              </PillButton>
                            ))}
                          </ControlGroup>
                          <ControlGroup label="難易度">
                            {(
                              [
                                ["easy", "易"],
                                ["medium", "中"],
                                ["hard", "難"],
                              ] as const
                            ).map(([v, l]) => (
                              <PillButton
                                key={v}
                                active={quizDifficulty === v}
                                onClick={() => setQuizDifficulty(v)}
                              >
                                {l}
                              </PillButton>
                            ))}
                          </ControlGroup>
                          <ControlGroup label="問題数">
                            {[3, 5, 10].map((n) => (
                              <PillButton
                                key={n}
                                active={quizCount === n}
                                onClick={() => setQuizCount(n)}
                              >
                                {n}
                              </PillButton>
                            ))}
                          </ControlGroup>
                        </div>

                        <button
                          type="button"
                          onClick={onGenerateQuiz}
                          disabled={quizLoading}
                          className="w-full px-3 py-1.5 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                        >
                          {quizLoading ? "問題を生成中..." : "問題を生成"}
                        </button>

                        {quizError && (
                          <p className="text-sm text-red-600 dark:text-red-400">
                            {quizError}
                          </p>
                        )}

                        {quizQuestions.length > 0 && (
                          <QuizView
                            questions={quizQuestions}
                            onRated={onQuizRated}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
          </>
        )}
      </main>

      <footer className="text-center text-xs text-zinc-500 py-4">
        AI 学習プラットフォーム · Phase 1 MVP
      </footer>

      {libraryOpen && (
        <LibraryPanel
          onClose={() => setLibraryOpen(false)}
          onOpen={openMaterial}
          refreshKey={libraryRefresh}
        />
      )}

      {examOpen && structure && (
        <ExamMode
          structure={structure}
          materialId={savedId}
          initialScopeKey={selectedKey}
          initialScopeTitle={selectedNode?.title ?? null}
          provider={provider}
          onClose={() => setExamOpen(false)}
        />
      )}
    </div>
  );
}

function ControlGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <div className="flex gap-1 flex-wrap">{children}</div>
    </div>
  );
}

function PillButton({
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
      className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
        active
          ? "bg-zinc-900 text-white border-zinc-900 dark:bg-white dark:text-zinc-900 dark:border-white"
          : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}
