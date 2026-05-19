import { getStudyNoteExport } from "@/lib/study-projects";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const note = await getStudyNoteExport(id);
  if (!note) {
    return new Response("Not found", { status: 404 });
  }
  const html = renderPrintableNote(note);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderPrintableNote(note: Awaited<ReturnType<typeof getStudyNoteExport>>) {
  if (!note) return "";
  const c = note.content;
  const keywords = c.keywords ?? [];
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(note.title)}</title>
  <style>
    @page { size: A4; margin: 18mm; }
    * { box-sizing: border-box; }
    body {
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Yu Gothic", "Meiryo", sans-serif;
      line-height: 1.75;
      margin: 0;
      background: #f8fafc;
    }
    main {
      max-width: 840px;
      margin: 0 auto;
      background: white;
      padding: 36px;
    }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { border-bottom: 1px solid #dbe5e8; font-size: 16px; margin: 28px 0 10px; padding-bottom: 6px; }
    p { margin: 0; white-space: pre-wrap; }
    .meta { color: #64748b; font-size: 12px; margin-bottom: 24px; }
    .key { background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 12px; padding: 14px; }
    .grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
    .toolbar { margin: 0 auto 16px; max-width: 840px; padding: 16px 0 0; text-align: right; }
    button { background: #0f766e; border: 0; border-radius: 10px; color: white; font-weight: 700; padding: 10px 14px; }
    @media print {
      body { background: white; }
      main { padding: 0; }
      .toolbar { display: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">PDFとして保存 / 印刷</button></div>
  <main>
    <h1>${escapeHtml(note.topicTitle)}</h1>
    <div class="meta">保存日: ${new Date(note.createdAt).toLocaleString("ja-JP")} / ${escapeHtml(c.pageLabel ?? "")}</div>
    ${section("概要", c.summary)}
    <div class="grid">
      ${card("何を学ぶのか", c.learningGoal)}
      ${card("なぜ重要なのか", c.importance)}
    </div>
    ${section("小学生でもわかる解説", c.explanation)}
    <div class="grid">
      ${card("補足知識", c.extraKnowledge)}
      ${card("★ここ大事", c.keyPoint, "key")}
    </div>
    ${section("教材内の根拠", c.excerpt)}
    ${keywords.length ? `<h2>関連キーワード</h2>${keywords.map((k) => `<div class="card"><strong>${escapeHtml(k.term)}</strong><p>${escapeHtml(k.meaning)}</p><p>${escapeHtml(k.example ?? k.image ?? "")}</p></div>`).join("")}` : ""}
  </main>
</body>
</html>`;
}

function section(title: string, body?: string) {
  if (!body) return "";
  return `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>`;
}

function card(title: string, body?: string, className = "") {
  return `<div class="card ${className}"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body || "未記入")}</p></div>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
