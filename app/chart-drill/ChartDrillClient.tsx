'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Eye,
  EyeOff,
  PauseCircle,
  RotateCcw,
  SkipForward,
  Target,
  Trophy,
  XCircle,
} from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { useWatchlistStore } from '@/lib/watchlist-store'
import type {
  DrillAnswer,
  DrillAnswerResult,
  DrillCandle,
  DrillConfidence,
  DrillDifficulty,
  DrillDirection,
  DrillQuestion,
  DrillTarget,
} from '@/lib/chart-drill/types'

const STORAGE_KEY = 'stockboard-chart-drill-history-v1'

type PresetId = 'starter' | 'surge' | 'drop' | 'short' | 'random' | 'custom'

interface Preset {
  id: PresetId
  label: string
  hint: string
  horizonDays: number
  thresholdPct: number
  direction: DrillDirection
  target: DrillTarget
  difficulty: DrillDifficulty
}

interface HistoryItem {
  answeredAt: string
  ticker: string
  name: string | null
  market: string
  asOfDate: string
  horizonDays: number
  thresholdPct: number
  direction: DrillDirection
  difficulty: DrillDifficulty
  answer: DrillAnswer
  expected: DrillAnswer
  confidence: DrillConfidence
  correct: boolean
  maxUpPct: number
  maxDownPct: number
  tags: string[]
}

const PRESETS: Preset[] = [
  {
    id: 'starter',
    label: '初動察知ドリル',
    hint: '10営業日以内に5%以上上昇',
    horizonDays: 10,
    thresholdPct: 5,
    direction: 'up',
    target: 'jp',
    difficulty: 'intermediate',
  },
  {
    id: 'surge',
    label: '急騰前夜ドリル',
    hint: '20営業日以内に10%以上上昇',
    horizonDays: 20,
    thresholdPct: 10,
    direction: 'up',
    target: 'jp',
    difficulty: 'beginner',
  },
  {
    id: 'drop',
    label: '急落回避ドリル',
    hint: '10営業日以内に5%以上下落',
    horizonDays: 10,
    thresholdPct: 5,
    direction: 'down',
    target: 'jp',
    difficulty: 'intermediate',
  },
  {
    id: 'short',
    label: '短期値幅ドリル',
    hint: '5営業日以内に3%以上変動',
    horizonDays: 5,
    thresholdPct: 3,
    direction: 'mixed',
    target: 'jp',
    difficulty: 'advanced',
  },
  {
    id: 'random',
    label: 'ランダム総合ドリル',
    hint: '上昇 / 下落 / 見送り混在',
    horizonDays: 10,
    thresholdPct: 5,
    direction: 'mixed',
    target: 'all',
    difficulty: 'practical',
  },
]

const HORIZON_OPTIONS = [3, 5, 10, 20, 60]
const THRESHOLD_OPTIONS = [3, 5, 10, 15, 20]
const ANSWER_LABELS: Record<DrillAnswer, string> = { up: '上がる', down: '下がる', pass: '見送り' }
const DIRECTION_LABELS: Record<DrillDirection, string> = { up: '上昇', down: '下落', mixed: 'ミックス' }
const TARGET_LABELS: Record<DrillTarget, string> = {
  jp: '日本株',
  us: '米国株',
  etf: 'ETF',
  commodity: 'コモディティETF',
  watchlist: '監視銘柄のみ',
  all: '全銘柄',
}
const DIFFICULTY_LABELS: Record<DrillDifficulty, string> = {
  beginner: '初級',
  intermediate: '中級',
  advanced: '上級',
  practical: '実戦',
}

export function ChartDrillClient() {
  const watchlistTickers = useWatchlistStore((state) => state.tickers)
  const [presetId, setPresetId] = useState<PresetId>('starter')
  const [horizonDays, setHorizonDays] = useState(10)
  const [thresholdPct, setThresholdPct] = useState(5)
  const [direction, setDirection] = useState<DrillDirection>('up')
  const [target, setTarget] = useState<DrillTarget>('jp')
  const [difficulty, setDifficulty] = useState<DrillDifficulty>('intermediate')
  const [questionCount, setQuestionCount] = useState(10)
  const [showIdentity, setShowIdentity] = useState(true)
  const [question, setQuestion] = useState<DrillQuestion | null>(null)
  const [result, setResult] = useState<DrillAnswerResult | null>(null)
  const [confidence, setConfidence] = useState<DrillConfidence>('medium')
  const [memo, setMemo] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [sessionAnswered, setSessionAnswered] = useState(0)
  const [loading, setLoading] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as HistoryItem[]
        if (Array.isArray(parsed)) setHistory(parsed.slice(0, 300))
      }
    } catch {
      // Ignore corrupted local history.
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, 300)))
    } catch {
      // Ignore storage quota errors.
    }
  }, [history])

  const stats = useMemo(() => buildStats(history), [history])

  function applyPreset(preset: Preset) {
    setPresetId(preset.id)
    setHorizonDays(preset.horizonDays)
    setThresholdPct(preset.thresholdPct)
    setDirection(preset.direction)
    setTarget(preset.target)
    setDifficulty(preset.difficulty)
    setQuestion(null)
    setResult(null)
    setError(null)
  }

  function markCustom() {
    if (presetId !== 'custom') setPresetId('custom')
  }

  async function loadQuestion() {
    setLoading(true)
    setAnswering(false)
    setError(null)
    setResult(null)
    setMemo('')
    try {
      if (target === 'watchlist' && watchlistTickers.length === 0) {
        throw new Error('監視銘柄が空です。銘柄詳細ページで☆を押してから試してください。')
      }
      const params = new URLSearchParams({
        horizonDays: String(horizonDays),
        thresholdPct: String(thresholdPct),
        direction,
        target,
        difficulty,
      })
      if (target === 'watchlist') params.set('watchlist', watchlistTickers.join(','))
      const res = await fetch(`/api/chart-drill/question?${params.toString()}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      setQuestion(json as DrillQuestion)
      setConfidence('medium')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function submitAnswer(answer: DrillAnswer) {
    if (!question || answering || result) return
    setAnswering(true)
    setError(null)
    try {
      const res = await fetch('/api/chart-drill/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problemId: question.problemId,
          answer,
          confidence,
          memo,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      const answerResult = json as DrillAnswerResult
      setResult(answerResult)
      setSessionAnswered((value) => value + 1)
      setHistory((items) => [
        {
          answeredAt: new Date().toISOString(),
          ticker: answerResult.question.ticker,
          name: answerResult.question.name,
          market: answerResult.question.market,
          asOfDate: answerResult.question.asOfDate,
          horizonDays: answerResult.question.horizonDays,
          thresholdPct: answerResult.question.thresholdPct,
          direction: answerResult.question.direction,
          difficulty: answerResult.question.difficulty,
          answer,
          expected: answerResult.expectedAnswer,
          confidence,
          correct: answerResult.correct,
          maxUpPct: answerResult.outcome.maxUpPct,
          maxDownPct: answerResult.outcome.maxDownPct,
          tags: answerResult.reviewTags,
        },
        ...items,
      ].slice(0, 300))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAnswering(false)
    }
  }

  const activeChart = result?.revealChart ?? question?.chart ?? []
  const identityTicker = question ? (showIdentity || result ? question.ticker : '????') : '----'
  const identityName = question ? (showIdentity || result ? question.name ?? '-' : '銘柄名非表示') : '問題未取得'

  return (
    <div className="sb-page">
      <PageTitle
        title="チャートドリル"
        subtitle="過去時点までのチャートだけを見て、上昇・下落・見送りを反復練習します。"
        badge="初動察知トレーニング"
        rightSlot={
          <Link
            href="/backtest"
            className="inline-flex h-7 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-2.5 text-[11px] font-black text-[var(--color-brand-800)] hover:border-[var(--color-market-red)] hover:text-[var(--color-market-red)]"
          >
            過去検証へ
          </Link>
        }
      />

      <div className="sb-section grid gap-3 lg:grid-cols-[360px_1fr]">
        <div className="space-y-3">
          <Card size="lg">
            <CardHeader title="出題条件" hint="プリセットから始め、必要なら条件を調整します。" />
            <div className="grid gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`rounded-[4px] border px-3 py-2 text-left transition-colors ${
                    presetId === preset.id
                      ? 'border-[var(--color-market-red)] bg-red-50'
                      : 'border-[var(--color-border-default)] bg-white hover:bg-[var(--color-surface-subtle)]'
                  }`}
                >
                  <div className="text-[13px] font-black text-[var(--color-brand-900)]">{preset.label}</div>
                  <div className="mt-0.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{preset.hint}</div>
                </button>
              ))}
            </div>

            <div className="mt-4 grid gap-3">
              <OptionGroup
                label="期間"
                values={HORIZON_OPTIONS}
                current={horizonDays}
                suffix="日"
                onSelect={(value) => { markCustom(); setHorizonDays(value) }}
              />
              <NumberField
                label="カスタム期間"
                value={horizonDays}
                min={1}
                max={180}
                suffix="営業日"
                onChange={(value) => { markCustom(); setHorizonDays(value) }}
              />
              <OptionGroup
                label="変動率"
                values={THRESHOLD_OPTIONS}
                current={thresholdPct}
                suffix="%"
                onSelect={(value) => { markCustom(); setThresholdPct(value) }}
              />
              <NumberField
                label="カスタム変動率"
                value={thresholdPct}
                min={0.5}
                max={80}
                step={0.5}
                suffix="%"
                onChange={(value) => { markCustom(); setThresholdPct(value) }}
              />
              <Segmented
                label="方向"
                options={[
                  ['up', '上昇'],
                  ['down', '下落'],
                  ['mixed', 'ミックス'],
                ]}
                value={direction}
                onChange={(value) => { markCustom(); setDirection(value as DrillDirection) }}
              />
              <Segmented
                label="対象"
                options={[
                  ['jp', '日本株'],
                  ['us', '米国株'],
                  ['etf', 'ETF'],
                  ['commodity', '商品ETF'],
                  ['watchlist', '監視'],
                  ['all', '全体'],
                ]}
                value={target}
                onChange={(value) => { markCustom(); setTarget(value as DrillTarget) }}
              />
              <Segmented
                label="難易度"
                options={[
                  ['beginner', '初級'],
                  ['intermediate', '中級'],
                  ['advanced', '上級'],
                  ['practical', '実戦'],
                ]}
                value={difficulty}
                onChange={(value) => { markCustom(); setDifficulty(value as DrillDifficulty) }}
              />
              <NumberField
                label="問題数"
                value={questionCount}
                min={1}
                max={100}
                suffix="問"
                onChange={setQuestionCount}
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={loadQuestion}
                disabled={loading}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-[4px] border border-[var(--color-market-red)] bg-[var(--color-market-red)] px-3 text-[13px] font-black text-white disabled:opacity-60"
              >
                <RotateCcw size={15} />
                {question ? '次の問題' : '開始'}
              </button>
              <button
                type="button"
                onClick={() => setShowIdentity((value) => !value)}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[13px] font-black text-[var(--color-brand-800)]"
              >
                {showIdentity ? <EyeOff size={15} /> : <Eye size={15} />}
                {showIdentity ? '銘柄非表示' : '銘柄表示'}
              </button>
            </div>
            <div className="mt-3 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
              出題時は基準日までの足だけを表示します。未来足と判定結果は回答後にサーバーで再計算して開示します。
            </div>
          </Card>

          <ScorePanel stats={stats} sessionAnswered={sessionAnswered} questionCount={questionCount} />
        </div>

        <div className="space-y-3">
          <Card size="lg">
            <div className="flex flex-col gap-3 border-b border-[var(--color-border-soft)] pb-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[20px] font-black tabular-nums text-[var(--color-brand-900)]">{identityTicker}</span>
                  <span className="text-[13px] font-bold text-[var(--color-text-secondary)]">{identityName}</span>
                  {question && (
                    <>
                      <Badge>{question.marketLabel}</Badge>
                      <Badge>{TARGET_LABELS[question.target]}</Badge>
                      <Badge>{DIFFICULTY_LABELS[question.difficulty]}</Badge>
                    </>
                  )}
                </div>
                <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-tertiary)]">
                  {question
                    ? `${question.asOfDate} 時点 / ${question.horizonDays}営業日以内 / ${question.thresholdPct}% / ${DIRECTION_LABELS[question.direction]}`
                    : '条件を選んで問題を開始してください。'}
                </div>
              </div>
              {question && (
                <Link
                  href={question.market === 'US' ? `/us/stock/${question.ticker}` : `/stock/${question.ticker}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-black text-[var(--color-brand-800)] hover:border-[var(--color-market-red)] hover:text-[var(--color-market-red)]"
                >
                  銘柄詳細
                  <ArrowUpRight size={14} />
                </Link>
              )}
            </div>

            {error && (
              <div className="mt-4 rounded-[4px] border border-red-200 bg-red-50 p-3 text-[13px] font-bold text-red-700">
                {error}
              </div>
            )}

            <div className="mt-4">
              {loading ? (
                <div className="flex h-[420px] items-center justify-center rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[13px] font-bold text-[var(--color-text-secondary)]">
                  問題を作成中…
                </div>
              ) : activeChart.length > 0 ? (
                <DrillSvgChart
                  candles={activeChart}
                  asOfDate={question?.asOfDate ?? null}
                  revealed={Boolean(result)}
                  horizonDays={question?.horizonDays ?? horizonDays}
                />
              ) : (
                <div className="flex h-[420px] items-center justify-center rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[13px] font-bold text-[var(--color-text-secondary)]">
                  まだ問題がありません。
                </div>
              )}
            </div>

            {question && <HintGrid question={question} />}

            {question && !result && (
              <div className="mt-4 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-black text-[var(--color-brand-900)]">回答</div>
                    <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                      基準日以降の未来足はまだ非表示です。
                    </div>
                  </div>
                  <Segmented
                    label="自信度"
                    compact
                    options={[
                      ['low', '低'],
                      ['medium', '中'],
                      ['high', '高'],
                    ]}
                    value={confidence}
                    onChange={(value) => setConfidence(value as DrillConfidence)}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <AnswerButton answer="up" loading={answering} onClick={submitAnswer} />
                  <AnswerButton answer="down" loading={answering} onClick={submitAnswer} />
                  <AnswerButton answer="pass" loading={answering} onClick={submitAnswer} />
                </div>
                <textarea
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  placeholder="理由メモ（任意）"
                  className="mt-3 min-h-20 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white p-2 text-[12px] font-semibold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-market-red)]"
                />
                <button
                  type="button"
                  onClick={loadQuestion}
                  disabled={loading || answering}
                  className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-black text-[var(--color-brand-800)]"
                >
                  <SkipForward size={14} />
                  スキップ
                </button>
              </div>
            )}

            {result && (
              <ResultPanel result={result} onNext={loadQuestion} />
            )}
          </Card>

          <HistoryPanel history={history} />
        </div>
      </div>
    </div>
  )
}

function OptionGroup({
  label,
  values,
  current,
  suffix,
  onSelect,
}: {
  label: string
  values: number[]
  current: number
  suffix: string
  onSelect: (value: number) => void
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-black text-[var(--color-brand-900)]">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            className={`h-8 rounded-[3px] border px-2.5 text-[12px] font-black ${
              current === value
                ? 'border-[var(--color-market-red)] bg-red-50 text-red-700'
                : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'
            }`}
          >
            {value}{suffix}
          </button>
        ))}
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix: string
  onChange: (value: number) => void
}) {
  return (
    <label className="grid grid-cols-[1fr_auto] items-center gap-2 text-[11px] font-black text-[var(--color-brand-900)]">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)))
          }}
          className="h-8 w-24 rounded-[3px] border border-[var(--color-border-default)] px-2 text-right text-[12px] font-black tabular-nums outline-none focus:border-[var(--color-market-red)]"
        />
        <span className="text-[11px] text-[var(--color-text-tertiary)]">{suffix}</span>
      </span>
    </label>
  )
}

function Segmented({
  label,
  options,
  value,
  onChange,
  compact = false,
}: {
  label: string
  options: Array<[string, string]>
  value: string
  onChange: (value: string) => void
  compact?: boolean
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-black text-[var(--color-brand-900)]">{label}</div>
      <div className={`flex flex-wrap gap-1 ${compact ? 'justify-end' : ''}`}>
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={`h-8 rounded-[3px] border px-2.5 text-[12px] font-black ${
              value === id
                ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white'
                : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function AnswerButton({ answer, loading, onClick }: { answer: DrillAnswer; loading: boolean; onClick: (answer: DrillAnswer) => void }) {
  const config = answer === 'up'
    ? { icon: ArrowUpRight, cls: 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100' }
    : answer === 'down'
      ? { icon: ArrowDownRight, cls: 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100' }
      : { icon: PauseCircle, cls: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50' }
  const Icon = config.icon
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => onClick(answer)}
      className={`flex h-12 items-center justify-center gap-2 rounded-[4px] border text-[14px] font-black disabled:opacity-60 ${config.cls}`}
    >
      <Icon size={18} />
      {ANSWER_LABELS[answer]}
    </button>
  )
}

function HintGrid({ question }: { question: DrillQuestion }) {
  const stageValues = [
    ['日A', question.stage.dailyA],
    ['日B', question.stage.dailyB],
    ['週A', question.stage.weeklyA],
    ['週B', question.stage.weeklyB],
    ['月A', question.stage.monthlyA],
    ['月B', question.stage.monthlyB],
  ] as const
  return (
    <div className="mt-4 grid gap-3 lg:grid-cols-[260px_1fr]">
      <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
        <div className="mb-2 text-[12px] font-black text-[var(--color-brand-900)]">6ステージ</div>
        <div className="grid grid-cols-3 gap-1.5">
          {stageValues.map(([label, value]) => (
            <div key={label} className="rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-2 text-center">
              <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
              <div className="mt-1 text-[16px] font-black text-[var(--color-brand-900)]">{value ?? '-'}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white p-3">
        <div className="mb-2 text-[12px] font-black text-[var(--color-brand-900)]">ヒント指標</div>
        <div className="grid gap-2 sm:grid-cols-3">
          <MiniMetric label="PMS" value={fmtScore(question.metrics.physicalMomentumScore)} />
          <MiniMetric label="PFS" value={fmtScore(question.metrics.physicalForceScore)} />
          <MiniMetric label="PES" value={fmtScore(question.metrics.physicalEnergyScore)} />
          <MiniMetric label="25日線傾き" value={fmtPct(question.metrics.ma25SlopePct)} />
          <MiniMetric label="25日乖離" value={fmtPct(question.metrics.priceVsMa25Pct)} />
          <MiniMetric label="出来高倍率" value={question.metrics.volumeRatio20 == null ? '-' : `${question.metrics.volumeRatio20.toFixed(2)}x`} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {question.hints.map((hint) => <Badge key={hint}>{hint}</Badge>)}
        </div>
      </div>
    </div>
  )
}

function ResultPanel({ result, onNext }: { result: DrillAnswerResult; onNext: () => void }) {
  return (
    <div className={`mt-4 rounded-[4px] border p-4 ${result.correct ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          {result.correct ? <CheckCircle2 className="text-green-700" size={22} /> : <XCircle className="text-red-700" size={22} />}
          <div>
            <div className={`text-[18px] font-black ${result.correct ? 'text-green-800' : 'text-red-800'}`}>
              {result.correct ? '正解' : '不正解'}
            </div>
            <div className="text-[12px] font-semibold text-[var(--color-text-secondary)]">
              回答: {ANSWER_LABELS[result.userAnswer]} / 正解: {ANSWER_LABELS[result.expectedAnswer]} / 自信度 {confidenceLabel(result.confidence)}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onNext}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[4px] border border-[var(--color-brand-800)] bg-white px-3 text-[13px] font-black text-[var(--color-brand-900)]"
        >
          次の問題
          <SkipForward size={15} />
        </button>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MiniMetric label="最大上昇率" value={fmtPct(result.outcome.maxUpPct)} />
        <MiniMetric label="最大下落率" value={fmtPct(result.outcome.maxDownPct)} />
        <MiniMetric label="条件達成" value={result.outcome.thresholdHitDay == null ? '未達' : `${result.outcome.thresholdHitDay}営業日目`} />
        <MiniMetric label="終値達成" value={result.outcome.closeHitDay == null ? '未達' : `${result.outcome.closeHitDay}営業日目`} />
      </div>
      <div className="mt-4 rounded-[4px] border border-white/80 bg-white p-3">
        <div className="text-[12px] font-black text-[var(--color-brand-900)]">解説</div>
        <ul className="mt-2 space-y-1.5 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
          {result.explanations.map((line) => <li key={line}>・{line}</li>)}
        </ul>
        {result.reviewTags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {result.reviewTags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
          </div>
        )}
      </div>
    </div>
  )
}

function ScorePanel({ stats, sessionAnswered, questionCount }: { stats: ReturnType<typeof buildStats>; sessionAnswered: number; questionCount: number }) {
  return (
    <Card>
      <CardHeader title="成績" hint={`今回 ${sessionAnswered}/${questionCount}問`} />
      <div className="grid grid-cols-2 gap-2">
        <MiniMetric label="総回答数" value={String(stats.total)} />
        <MiniMetric label="正答率" value={stats.total === 0 ? '-' : `${stats.accuracy.toFixed(1)}%`} />
        <MiniMetric label="連続正解" value={`${stats.currentStreak}`} />
        <MiniMetric label="最高連続" value={`${stats.bestStreak}`} />
      </div>
      <div className="mt-3 grid gap-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
        <ScoreLine label="上昇問題" value={stats.byExpected.up} />
        <ScoreLine label="下落問題" value={stats.byExpected.down} />
        <ScoreLine label="見送り判断" value={stats.byExpected.pass} />
      </div>
      <div className="mt-3 rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-2">
        <div className="text-[11px] font-black text-[var(--color-brand-900)]">振り返り</div>
        <div className="mt-1 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
          {stats.weakness}
        </div>
      </div>
    </Card>
  )
}

function ScoreLine({ label, value }: { label: string; value: { total: number; correct: number } }) {
  const pct = value.total > 0 ? 100 * value.correct / value.total : null
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="tabular-nums">{pct == null ? '-' : `${pct.toFixed(1)}%`} <span className="text-[var(--color-text-tertiary)]">({value.correct}/{value.total})</span></span>
    </div>
  )
}

function HistoryPanel({ history }: { history: HistoryItem[] }) {
  return (
    <Card>
      <CardHeader title="回答履歴" hint="直近の結果から苦手パターンを見直します。" />
      {history.length === 0 ? (
        <p className="text-[13px] font-semibold text-[var(--color-text-secondary)]">まだ回答履歴はありません。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead className="bg-[var(--color-surface-subtle)] text-[11px] text-[var(--color-text-tertiary)]">
              <tr>
                <th className="px-2 py-2 text-left">結果</th>
                <th className="px-2 py-2 text-left">銘柄</th>
                <th className="px-2 py-2 text-left">基準日</th>
                <th className="px-2 py-2 text-right">条件</th>
                <th className="px-2 py-2 text-right">最大上昇</th>
                <th className="px-2 py-2 text-right">最大下落</th>
                <th className="px-2 py-2 text-left">タグ</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 12).map((row, index) => (
                <tr key={`${row.answeredAt}-${index}`} className="border-b border-[var(--color-border-soft)]">
                  <td className={`px-2 py-2 font-black ${row.correct ? 'text-green-700' : 'text-red-700'}`}>{row.correct ? '正解' : '不正解'}</td>
                  <td className="px-2 py-2 font-bold text-[var(--color-brand-900)]">{row.ticker} <span className="text-[var(--color-text-tertiary)]">{row.name ?? ''}</span></td>
                  <td className="px-2 py-2 tabular-nums">{row.asOfDate}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{row.horizonDays}日 / {row.thresholdPct}%</td>
                  <td className="px-2 py-2 text-right tabular-nums text-red-700">{fmtPct(row.maxUpPct)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-blue-700">{fmtPct(row.maxDownPct)}</td>
                  <td className="px-2 py-2">{row.tags.slice(0, 3).join(' / ') || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function DrillSvgChart({
  candles,
  asOfDate,
  revealed,
  horizonDays,
}: {
  candles: DrillCandle[]
  asOfDate: string | null
  revealed: boolean
  horizonDays: number
}) {
  const chart = useMemo(() => buildChartGeometry(candles, asOfDate), [candles, asOfDate])
  if (!chart) {
    return <div className="flex h-[420px] items-center justify-center rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">チャートデータが不足しています。</div>
  }
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
        <span>{candles[0]?.date} → {candles.at(-1)?.date}</span>
        <span>{revealed ? `未来${horizonDays}営業日を開示` : '未来足は非表示'}</span>
      </div>
      <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="チャートドリル ローソク足" className="h-[420px] w-full max-w-full">
        <rect x="0" y="0" width={chart.width} height={chart.height} fill="#fff" />
        {chart.revealX != null && (
          <>
            <rect x={chart.revealX} y="0" width={chart.width - chart.revealX} height={chart.priceHeight} fill="rgba(245, 158, 11, 0.08)" />
            <line x1={chart.revealX} x2={chart.revealX} y1="0" y2={chart.height} stroke="#f59e0b" strokeDasharray="5 4" strokeWidth="2" />
          </>
        )}
        {chart.gridY.map((y) => <line key={y} x1="0" x2={chart.width} y1={y} y2={y} stroke="rgba(15,23,42,0.06)" />)}
        <Polyline points={chart.ma75Points} stroke="#2563eb" />
        <Polyline points={chart.ma25Points} stroke="#f59e0b" />
        <Polyline points={chart.ma5Points} stroke="#94a3b8" />
        {chart.candles.map((candle) => (
          <g key={candle.date}>
            <line x1={candle.x} x2={candle.x} y1={candle.highY} y2={candle.lowY} stroke={candle.color} strokeWidth="1.2" />
            <rect
              x={candle.x - chart.candleWidth / 2}
              y={Math.min(candle.openY, candle.closeY)}
              width={chart.candleWidth}
              height={Math.max(1.5, Math.abs(candle.openY - candle.closeY))}
              fill={candle.color}
              opacity="0.9"
              rx="0.8"
            />
          </g>
        ))}
        <g transform={`translate(0 ${chart.priceHeight + 14})`}>
          {chart.volumeBars.map((bar) => (
            <rect key={bar.date} x={bar.x - chart.candleWidth / 2} y={bar.y} width={chart.candleWidth} height={bar.height} fill={bar.color} opacity="0.28" />
          ))}
        </g>
        <text x="8" y="16" fill="#64748b" fontSize="11" fontWeight="700">MA 5 / 25 / 75・出来高</text>
      </svg>
    </div>
  )
}

function Polyline({ points, stroke }: { points: string; stroke: string }) {
  if (!points) return null
  return <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
}

function buildChartGeometry(candles: DrillCandle[], asOfDate: string | null) {
  const valid = candles.filter((row) => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close))
  if (valid.length < 5) return null
  const width = 980
  const priceHeight = 300
  const volumeHeight = 82
  const height = priceHeight + volumeHeight + 22
  const high = Math.max(...valid.map((row) => row.high), ...valid.flatMap((row) => [row.ma5, row.ma25, row.ma75].filter((v): v is number => v != null && Number.isFinite(v))))
  const low = Math.min(...valid.map((row) => row.low), ...valid.flatMap((row) => [row.ma5, row.ma25, row.ma75].filter((v): v is number => v != null && Number.isFinite(v))))
  const pad = Math.max(0.01, (high - low) * 0.08)
  const min = low - pad
  const max = high + pad
  const xStep = width / Math.max(1, valid.length - 1)
  const candleWidth = Math.max(2, Math.min(8, xStep * 0.58))
  const y = (value: number) => priceHeight - ((value - min) / (max - min || 1)) * priceHeight
  const x = (index: number) => index * xStep
  const maxVolume = Math.max(...valid.map((row) => row.volume), 1)
  const candlesGeom = valid.map((row, index) => ({
    date: row.date,
    x: x(index),
    openY: y(row.open),
    highY: y(row.high),
    lowY: y(row.low),
    closeY: y(row.close),
    color: row.close >= row.open ? '#dc2626' : '#2563eb',
  }))
  const volumeBars = valid.map((row, index) => ({
    date: row.date,
    x: x(index),
    y: volumeHeight - (row.volume / maxVolume) * volumeHeight,
    height: Math.max(1, (row.volume / maxVolume) * volumeHeight),
    color: row.close >= row.open ? '#dc2626' : '#2563eb',
  }))
  const maPoints = (key: 'ma5' | 'ma25' | 'ma75') => valid
    .map((row, index) => row[key] == null ? null : `${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`)
    .filter((point): point is string => point != null)
    .join(' ')
  const asOfIndex = asOfDate ? valid.findIndex((row) => row.date === asOfDate) : -1
  return {
    width,
    height,
    priceHeight,
    candleWidth,
    revealX: asOfIndex >= 0 && asOfIndex < valid.length - 1 ? x(asOfIndex) + xStep / 2 : null,
    gridY: [0.2, 0.4, 0.6, 0.8].map((ratio) => priceHeight * ratio),
    candles: candlesGeom,
    volumeBars,
    ma5Points: maPoints('ma5'),
    ma25Points: maPoints('ma25'),
    ma75Points: maPoints('ma75'),
  }
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-white px-2 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[13px] font-black tabular-nums text-[var(--color-brand-900)]">{value}</div>
    </div>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-h-6 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-black text-[var(--color-brand-800)]">
      {children}
    </span>
  )
}

function buildStats(history: HistoryItem[]) {
  const total = history.length
  const correct = history.filter((item) => item.correct).length
  const byExpected = {
    up: countByExpected(history, 'up'),
    down: countByExpected(history, 'down'),
    pass: countByExpected(history, 'pass'),
  }
  let currentStreak = 0
  for (const item of history) {
    if (!item.correct) break
    currentStreak += 1
  }
  let bestStreak = 0
  let run = 0
  for (const item of history) {
    if (item.correct) {
      run += 1
      bestStreak = Math.max(bestStreak, run)
    } else {
      run = 0
    }
  }
  const weakness = weakestMessage(byExpected, history)
  return {
    total,
    correct,
    accuracy: total > 0 ? 100 * correct / total : 0,
    byExpected,
    currentStreak,
    bestStreak,
    weakness,
  }
}

function countByExpected(history: HistoryItem[], expected: DrillAnswer) {
  const rows = history.filter((item) => item.expected === expected)
  return { total: rows.length, correct: rows.filter((item) => item.correct).length }
}

function weakestMessage(byExpected: Record<DrillAnswer, { total: number; correct: number }>, history: HistoryItem[]): string {
  if (history.length < 5) return 'まずは5問ほど解くと、苦手な方向や見送り判断の癖が見えてきます。'
  const scored = (Object.entries(byExpected) as Array<[DrillAnswer, { total: number; correct: number }]>)
    .filter(([, value]) => value.total >= 2)
    .map(([key, value]) => ({ key, pct: value.correct / value.total }))
    .sort((a, b) => a.pct - b.pct)
  const weakest = scored[0]
  if (!weakest) return '回答数をもう少し増やすと、苦手パターンを判定できます。'
  if (weakest.key === 'up') return '上昇初動の見極めが相対的に弱めです。MA上向き転換とPMS/PFSの同時改善を重点的に見返してください。'
  if (weakest.key === 'down') return '下落初動の察知が相対的に弱めです。短期線下向き、25日線割れ、PMS低下の組み合わせを重点的に見返してください。'
  return '見送り判断が相対的に弱めです。上下どちらにも条件未達の低期待値パターンを見返してください。'
}

function confidenceLabel(value: DrillConfidence): string {
  if (value === 'high') return '高'
  if (value === 'low') return '低'
  return '中'
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}
