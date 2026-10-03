'use client'

import { CalendarClock, Database, Gauge, History, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { MlReliabilityAssessment } from '@/lib/ml/reliability'

function fmtCount(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function toneStyle(tone: MlReliabilityAssessment['tone']) {
  if (tone === 'good') {
    return { color: '#166534', border: 'rgba(22, 101, 52, 0.28)', background: 'rgba(22, 163, 74, 0.06)' }
  }
  if (tone === 'caution') {
    return { color: '#92400e', border: 'rgba(217, 119, 6, 0.32)', background: 'rgba(245, 158, 11, 0.08)' }
  }
  return { color: '#9f1239', border: 'rgba(190, 18, 60, 0.3)', background: 'rgba(225, 29, 72, 0.06)' }
}

function Metric({ icon: Icon, label, value, detail }: {
  icon: typeof CalendarClock
  label: string
  value: string
  detail?: string
}) {
  return (
    <div style={{ minWidth: 0, display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 7, alignItems: 'start' }}>
      <Icon size={16} aria-hidden="true" style={{ marginTop: 1, color: 'var(--text-muted)' }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>{label}</div>
        <div style={{ marginTop: 2, fontSize: 12, fontWeight: 900, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{value}</div>
        {detail && <div style={{ marginTop: 2, fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', lineHeight: 1.4 }}>{detail}</div>}
      </div>
    </div>
  )
}

export function MlReliabilityStrip({ assessment }: { assessment: MlReliabilityAssessment }) {
  const tone = toneStyle(assessment.tone)
  const accuracy = assessment.historicalAccuracy == null
    ? '実績確定待ち'
    : `${Math.round(assessment.historicalAccuracy * 100)}% (${assessment.hitPredictions}/${assessment.completedPredictions})`
  const similarValue = assessment.topSimilarity == null
    ? `${assessment.similarCount}件`
    : `${assessment.similarCount}件 / 最高${Math.round(assessment.topSimilarity * 100)}%`
  const validationValue = assessment.validationRuns == null
    ? '-'
    : `${fmtCount(assessment.validationRuns)}区分`
  const validationDetail = assessment.validationSamples == null
    ? undefined
    : `${fmtCount(assessment.validationSamples)}標本`
  const StatusIcon = assessment.tone === 'good' ? ShieldCheck : TriangleAlert

  return (
    <section
      aria-label="ML信頼性チェック"
      style={{
        borderTop: `1px solid ${tone.border}`,
        borderBottom: `1px solid ${tone.border}`,
        background: tone.background,
        padding: '10px 2px',
        display: 'grid',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', gap: 7, alignItems: 'start', minWidth: 0, flex: '1 1 280px' }}>
          <StatusIcon size={18} aria-hidden="true" style={{ marginTop: 1, color: tone.color }} />
          <div>
            <div style={{ fontSize: 10, fontWeight: 900, color: 'var(--text-muted)' }}>ML信頼性チェック</div>
            <div style={{ marginTop: 2, fontSize: 14, fontWeight: 900, color: tone.color }}>{assessment.label}</div>
            <p style={{ margin: '3px 0 0', fontSize: 11, lineHeight: 1.55, fontWeight: 700, color: 'var(--text-secondary)' }}>
              {assessment.summary}
            </p>
          </div>
        </div>
        {assessment.outOfDistribution && (
          <span style={{ border: `1px solid ${tone.border}`, background: 'white', color: tone.color, padding: '4px 8px', fontSize: 10, fontWeight: 900 }}>
            適用範囲を要確認
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px 14px' }}>
        <Metric icon={CalendarClock} label="特徴量基準日" value={assessment.featureDate ?? '-'} />
        <Metric icon={Gauge} label="モデル学習日" value={assessment.modelDate ?? '-'} />
        <Metric icon={Database} label="類似候補" value={similarValue} />
        <Metric icon={History} label="銘柄別の過去一致率" value={accuracy} />
        <Metric icon={ShieldCheck} label="全体検証" value={validationValue} detail={validationDetail} />
      </div>
      {(assessment.warnings.length > 0 || assessment.notes.length > 0) && (
        <div style={{ display: 'grid', gap: 3 }}>
          {assessment.warnings.map((warning) => (
            <div key={warning} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr)', gap: 5, fontSize: 10, lineHeight: 1.5, fontWeight: 800, color: tone.color }}>
              <TriangleAlert size={13} aria-hidden="true" style={{ marginTop: 1 }} />
              <span>{warning}</span>
            </div>
          ))}
          {assessment.notes.map((note) => (
            <div key={note} style={{ paddingLeft: 19, fontSize: 10, lineHeight: 1.5, fontWeight: 700, color: 'var(--text-muted)' }}>{note}</div>
          ))}
        </div>
      )}
    </section>
  )
}
