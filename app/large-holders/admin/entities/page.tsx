'use client'

import { useCallback, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import type { ReviewDecision } from '@/lib/large-holders/entity-review'

type QueueRow = { investorEntityId: string; displayName: string; investorClass: string;
  investorType: string; aliases: string[]; reasons: string[]; possibleMatches: string[];
  positions: { ticker: string; documentId: string; pct: number | null; estimatedCurrentValue: number | null }[] }
type Document = { documentId: string; sourceSha256: string | null; sourceUrl: string;
  filingDate: string; investorEntityIds: string[] }
type State = { counts: Record<string, number>; queue: QueueRow[]; documents: Document[];
  history: ReviewDecision[]; publishedReviewCurrent: boolean; snapshotId: string }
type Health = { snapshotId: string | null; snapshotGeneratedAt: string | null; snapshotStatus: string;
  source: { filings: { total: number; failed: number; review: number; latestSubmittedAt: string | null };
    marketDate: string | null; priceEvidenceDate: string | null; unresolvedCorrections: number;
    sourceQualityReview: { documentId: string; ticker: string | null; issuer: string | null;
      submittedAt: string; disposition: string; reason: string | null;
      coverDeclaredCount: number | null; parsedLegalHolderCount: number | null;
      rawAxisMemberCount: number | null; rawSourceSha256: string | null;
      reviewStatus: string; sourceUrl: string;
      affectedHolderMembers: { member: string; name: string; shares: number | null }[] }[] };
  storage: { failedSafe: boolean; probeUncertain: boolean };
  lastSuccess: { at: string; stage: string; detail?: Record<string, unknown> } | null;
  lastError: { at: string; stage: string; detail?: Record<string, unknown> } | null;
  quality: { ambiguousEntities: number; valuationUnavailable: number | null; parseFailures: number } }
type DecisionInput = Partial<ReviewDecision>

const labels: Record<string, string> = {
  INDIVIDUAL: '個人', INSTITUTIONAL: '機関', OTHER: 'その他', UNCLASSIFIED: '未分類',
  UNCLASSIFIED_REASON: '未分類', POSSIBLE_ALIAS_OR_NAME_CHANGE: '別名・改称の可能性',
  SAME_NAME_DISTINCT_CANDIDATE: '同名の別Entity候補',
  AUTO_UNCERTAIN: '自動分類が不確実', POSSIBLE_ALIAS: '別名重複候補',
}

export default function LargeHolderEntityAdmin() {
  const [state, setState] = useState<State | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [token, setToken] = useState('')
  const [kind, setKind] = useState<'CLASSIFY' | 'MERGE' | 'UNDO'>('CLASSIFY')
  const [entityId, setEntityId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [category, setCategory] = useState('INDIVIDUAL')
  const [documentId, setDocumentId] = useState('')
  const [note, setNote] = useState('')
  const [undoId, setUndoId] = useState('')
  const [preview, setPreview] = useState<unknown>(null)
  const [previewHash, setPreviewHash] = useState('')
  const [message, setMessage] = useState('')

  const reload = useCallback(async (adminToken: string) => {
    const response = await fetch('/api/large-holders/admin/entities', { cache: 'no-store',
      headers: { 'x-large-holder-admin-token': adminToken } })
    if (!response.ok) throw new Error('管理データを取得できません')
    setState(await response.json() as State)
    const healthResponse = await fetch('/api/large-holders/admin/health', { cache: 'no-store',
      headers: { 'x-large-holder-admin-token': adminToken } })
    if (healthResponse.ok) setHealth(await healthResponse.json() as Health)
  }, [])

  const related = state?.documents.filter((doc) => doc.investorEntityIds.includes(entityId)
    || doc.investorEntityIds.includes(targetId)) ?? []
  const selectedDocument = related.find((doc) => doc.documentId === documentId)
  const decision: DecisionInput = kind === 'CLASSIFY'
    ? { kind, entityId, category: category as ReviewDecision['category'],
      evidence: { documentId, sourceSha256: selectedDocument?.sourceSha256 ?? '', note } }
    : kind === 'MERGE'
      ? { kind, sourceEntityId: entityId, targetEntityId: targetId,
        evidence: { documentId, sourceSha256: selectedDocument?.sourceSha256 ?? '', note } }
      : { kind, undoId, note }

  async function submit(action: 'preview' | 'commit') {
    setMessage('')
    const response = await fetch('/api/large-holders/admin/entities', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-large-holder-admin-token': token },
      body: JSON.stringify({ action, decision, previewHash }),
    })
    const result = await response.json() as { error?: string; preview?: unknown;
      previewHash?: string; snapshotRefreshRequired?: boolean }
    if (!response.ok) { setPreview(null); setMessage(result.error ?? '操作に失敗しました'); return }
    if (action === 'preview') { setPreview(result.preview); setPreviewHash(result.previewHash ?? ''); return }
    setPreview(null)
    setMessage('審査履歴に追記しました。公開反映にはsnapshot-refreshが必要です。')
    await reload(token)
  }

  return <main className="page-wide mx-auto px-4 py-6 text-[var(--color-text-primary)]">
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--color-border-default)] pb-4">
      <div><h1 className="text-xl font-bold">大口保有 Entity審査</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">公式原資料を根拠に確認。未分類は推測で確定しません。</p></div>
      <span className="text-xs text-[var(--color-text-tertiary)]">Snapshot {state?.snapshotId.slice(0, 12) ?? '—'}</span>
    </div>
    {state && <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-review-coverage>
      {['INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED'].map((type) =>
        <span key={type}>{labels[type]} <strong>{state.counts[type] ?? 0}</strong></span>)}
      <span>審査候補 <strong>{state.queue.length}</strong></span>
    </div>}
    {state && !state.publishedReviewCurrent && <p className="mt-3 flex items-center gap-2 text-sm text-amber-800"><AlertTriangle size={15} /> 審査履歴が公開Snapshotへ未反映です。</p>}
    {health && <section className="mt-4 border-y border-[var(--color-border-soft)] py-3 text-xs text-[var(--color-text-secondary)]" aria-label="運用状態">
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span>EDINET最終提出 {health.source.filings.latestSubmittedAt ?? '—'}</span>
        <span>価格 {health.source.marketDate ?? '—'} / 証拠 {health.source.priceEvidenceDate ?? '—'}</span>
        <span>Snapshot生成 {health.snapshotGeneratedAt ?? '—'}</span>
        <span>最終成功 {health.lastSuccess?.at ?? '—'}</span>
        <span>最終失敗 {health.lastError?.at ?? '—'}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
        <span>取込 {health.source.filings.total ?? 0} / parse失敗 {health.quality.parseFailures}</span>
        <span>未解決訂正 {health.source.unresolvedCorrections}</span>
        <span>同名候補 {health.quality.ambiguousEntities}</span>
        <span>評価不可Position {health.quality.valuationUnavailable ?? '—'}</span>
        <span>Storage {health.storage.failedSafe ? 'FAILED_SAFE' : health.storage.probeUncertain ? 'PROBE_UNCERTAIN' : '正常'}</span>
      </div>
    </section>}
    {health && health.source.sourceQualityReview.length > 0 && <section className="mt-4" aria-label="原資料品質審査">
      <h2 className="text-base font-semibold">Source Quality Review</h2>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">隔離は原資料内の不整合を示します。保有者数や保有額の推測補正は行いません。</p>
      <div className="mt-2 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {health.source.sourceQualityReview.map((item) => <details key={item.documentId} className="py-2 text-sm">
          <summary className="cursor-pointer font-medium">{item.documentId} / {item.issuer ?? item.ticker ?? '発行体未特定'} / {item.disposition}</summary>
          <div className="mt-2 space-y-1 pl-3 text-[13px] text-[var(--color-text-secondary)]">
            <p>提出 {item.submittedAt} / 理由 {item.reason ?? '—'} / 審査 {item.reviewStatus}</p>
            <p>表紙 {item.coverDeclaredCount ?? '—'} / 法的保有者 {item.parsedLegalHolderCount ?? '—'} / axis member {item.rawAxisMemberCount ?? '—'}</p>
            <p className="break-all">原本SHA-256 {item.rawSourceSha256 ?? '未取得'}</p>
            <p>{item.affectedHolderMembers.map((holder) => `${holder.name} (${holder.shares ?? '—'})`).join(' / ')}</p>
            <a className="inline-flex items-center gap-1 text-[var(--color-brand-700)]" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">EDINET原資料 <ExternalLink size={13} /></a>
          </div>
        </details>)}
      </div>
    </section>}
    <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
      <section className="min-w-0">
        <h2 className="border-b border-[var(--color-border-soft)] pb-2 text-base font-semibold">審査キュー</h2>
        <div className="max-h-[640px] overflow-auto">
          {state?.queue.map((row) => <button key={row.investorEntityId} type="button"
            onClick={() => { setEntityId(row.investorEntityId); setDocumentId(''); setPreview(null) }}
            className="block w-full border-b border-[var(--color-border-soft)] px-1 py-3 text-left hover:bg-[var(--color-surface-subtle)]">
            <span className="font-semibold">{row.displayName}</span>
            <span className="ml-2 text-xs text-[var(--color-text-secondary)]">{labels[row.investorClass]} / {row.investorType}</span>
            <span className="mt-1 block text-xs text-[var(--color-text-tertiary)]">{row.reasons.map((reason) => labels[reason] ?? reason).join(' / ')}</span>
            <span className="mt-1 block text-xs text-[var(--color-text-secondary)]">別名: {row.aliases.join(' / ') || '—'} ・ 保有: {row.positions.map((position) => `${position.ticker} ${position.pct ?? '—'}%`).join(' / ') || '—'}</span>
            {row.possibleMatches.length > 0 && <span className="mt-1 block text-xs">同名候補: {row.possibleMatches.join(', ')}</span>}
          </button>)}
          {state?.queue.length === 0 && <p className="py-4 text-sm text-[var(--color-text-secondary)]">審査候補はありません。</p>}
        </div>
      </section>
      <section className="min-w-0 border-t border-[var(--color-border-soft)] pt-4 lg:border-t-0 lg:pt-0">
        <h2 className="border-b border-[var(--color-border-soft)] pb-2 text-base font-semibold">証拠付き操作</h2>
        <div className="mt-3 space-y-3 text-sm">
          <label className="block">管理トークン<input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="mt-1 w-full rounded border px-2 py-2" /></label>
          <button type="button" onClick={() => void reload(token).then(() => setMessage('')).catch((error) => setMessage(String(error)))} className="rounded border border-[var(--color-border-default)] px-3 py-2">審査データを読む</button>
          <label className="block">操作<select value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setPreview(null) }} className="mt-1 w-full rounded border px-2 py-2">
            <option value="CLASSIFY">分類</option><option value="MERGE">統合</option><option value="UNDO">取り消し</option>
          </select></label>
          {kind !== 'UNDO' && <label className="block">対象Entity ID<input value={entityId} onChange={(e) => { setEntityId(e.target.value); setPreview(null) }} className="mt-1 w-full rounded border px-2 py-2" /></label>}
          {kind === 'CLASSIFY' && <label className="block">分類<select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 w-full rounded border px-2 py-2">
            {['INDIVIDUAL', 'DOMESTIC_ASSET_MANAGER', 'FOREIGN_ASSET_MANAGER', 'FUND', 'FINANCIAL_INSTITUTION', 'OPERATING_COMPANY', 'OTHER_CORPORATION'].map((name) => <option key={name}>{name}</option>)}
          </select></label>}
          {kind === 'MERGE' && <label className="block">統合先Entity ID<input value={targetId} onChange={(e) => { setTargetId(e.target.value); setPreview(null) }} className="mt-1 w-full rounded border px-2 py-2" /></label>}
          {kind !== 'UNDO' && <>
            <label className="block">根拠書類<select value={documentId} onChange={(e) => { setDocumentId(e.target.value); setPreview(null) }} className="mt-1 w-full rounded border px-2 py-2">
              <option value="">選択してください</option>{related.map((doc) => <option key={doc.documentId} value={doc.documentId}>{doc.documentId} / {doc.filingDate}</option>)}
            </select></label>
            {selectedDocument && <a className="inline-flex items-center gap-1 text-[var(--color-brand-700)]" href={selectedDocument.sourceUrl} target="_blank" rel="noopener noreferrer">EDINET原資料 <ExternalLink size={13} /></a>}
            <label className="block">判断根拠<input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded border px-2 py-2" /></label>
          </>}
          {kind === 'UNDO' && <label className="block">取り消すDecision ID<select value={undoId} onChange={(e) => setUndoId(e.target.value)} className="mt-1 w-full rounded border px-2 py-2">
            <option value="">選択してください</option>{state?.history.filter((row) => row.kind !== 'UNDO').map((row) => <option key={row.id} value={row.id}>{row.kind} / {row.id}</option>)}
          </select></label>}
          {kind === 'UNDO' && <label className="block">取り消し理由<input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded border px-2 py-2" /></label>}
          <button type="button" onClick={() => void submit('preview')} className="rounded border border-[var(--color-border-default)] px-3 py-2">変更をプレビュー</button>
          {preview != null && <><pre className="overflow-auto bg-[var(--color-surface-subtle)] p-2 text-xs">{JSON.stringify(preview, null, 2)}</pre>
            <button type="button" onClick={() => void submit('commit')} className="rounded bg-[var(--color-brand-700)] px-3 py-2 text-white">審査履歴へ保存</button></>}
          {message && <p role="status" className="text-sm">{message}</p>}
        </div>
      </section>
    </div>
  </main>
}
