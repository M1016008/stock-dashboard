// app/alerts/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { useAlertStore } from '@/lib/alert-store'
import { evaluateAllAlerts } from '@/lib/alert-engine'
import { AlertForm } from '@/components/alerts/AlertForm'
import { AlertRow } from '@/components/alerts/AlertRow'
import type { OHLCV, StockQuote } from '@/types/stock'

const EVALUATION_INTERVAL_MS = 5 * 60 * 1000 // 5分ごとに評価

export default function AlertsPage() {
  const alerts = useAlertStore((s) => s.alerts)
  const updateLastTriggered = useAlertStore((s) => s.updateLastTriggered)
  const [evaluating, setEvaluating] = useState(false)
  const [lastEvalAt, setLastEvalAt] = useState<Date | null>(null)
  const [lastTriggerCount, setLastTriggerCount] = useState<number | null>(null)
  const [mailStatus, setMailStatus] = useState<{ configured: boolean; ok: boolean } | null>(null)

  // 起動時にメール設定状況を確認
  useEffect(() => {
    fetch('/api/alert/notify')
      .then((r) => r.json())
      .then((d) => setMailStatus({ configured: d.configured, ok: d.connectionOk }))
      .catch(() => setMailStatus({ configured: false, ok: false }))
  }, [])

  // 評価ジョブ
  useEffect(() => {
    if (alerts.length === 0) return

    let cancelled = false

    async function runEvaluation() {
      const enabled = alerts.filter((a) => a.enabled)
      if (enabled.length === 0) return

      setEvaluating(true)
      try {
        const fetchData = async (ticker: string) => {
          const enc = encodeURIComponent(ticker)
          const [qRes, hRes] = await Promise.all([
            fetch(`/api/quote/${enc}`),
            fetch(`/api/history/${enc}?period=6mo`),
          ])
          const quote: StockQuote = qRes.ok ? await qRes.json() : { price: 0 } as StockQuote
          const ohlcv: OHLCV[] = hRes.ok ? await hRes.json() : []
          return { ohlcv, currentPrice: quote.price }
        }

        const triggered = await evaluateAllAlerts(enabled, fetchData)
        if (cancelled) return

        // 発火したアラートに対して通知 + lastTriggered 更新
        if (triggered.length > 0) {
          // メールでまとめて通知（メール毎にグループ）
          const byEmail = new Map<string, typeof triggered>()
          for (const alert of triggered) {
            const list = byEmail.get(alert.email) ?? []
            list.push(alert)
            byEmail.set(alert.email, list)
          }
          for (const [to, group] of byEmail) {
            try {
              await fetch('/api/alert/notify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alerts: group, to, type: 'REALTIME' }),
              })
            } catch (e) {
              console.error('Notify error:', e)
            }
          }
          for (const alert of triggered) {
            updateLastTriggered(alert.id)
          }
        }

        setLastEvalAt(new Date())
        setLastTriggerCount(triggered.length)
      } catch (e) {
        console.error('Evaluation error:', e)
      } finally {
        if (!cancelled) setEvaluating(false)
      }
    }

    runEvaluation()
    const interval = setInterval(runEvaluation, EVALUATION_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [alerts, updateLastTriggered])

  const enabledCount = alerts.filter((a) => a.enabled).length

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>アラート設定</h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          株価・テクニカル条件のアラートと Gmail 通知（このページを開いている間に評価）
        </p>
      </div>

      {/* ステータス */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
        <StatusCard
          label="登録アラート"
          value={`${alerts.length}件`}
          sub={`有効: ${enabledCount}件`}
        />
        <StatusCard
          label="メール設定"
          value={mailStatus ? (mailStatus.configured ? '✓ 設定済' : '⚠ 未設定') : '確認中'}
          sub={mailStatus?.configured ? (mailStatus.ok ? '接続OK' : '接続NG') : '.env.local 要設定'}
          color={mailStatus?.configured ? 'var(--price-up)' : 'var(--price-down)'}
        />
        <StatusCard
          label="評価ステータス"
          value={evaluating ? '評価中…' : '待機中'}
          sub={`5分間隔`}
        />
        <StatusCard
          label="最終評価"
          value={lastEvalAt ? lastEvalAt.toLocaleTimeString('ja-JP') : '---'}
          sub={lastTriggerCount !== null ? `発火: ${lastTriggerCount}件` : '未実行'}
        />
      </div>

      <AlertForm />

      {/* アラート一覧 */}
      {alerts.length > 0 ? (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                  <th style={headStyle}>状態</th>
                  <th style={headStyle}>銘柄</th>
                  <th style={headStyle}>条件</th>
                  <th style={headStyle}>通知先</th>
                  <th style={headStyle}>クールダウン</th>
                  <th style={headStyle}>最終発火</th>
                  <th style={headStyle}></th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            登録されているアラートはありません。上のフォームから作成してください。
          </p>
        </div>
      )}

      {!mailStatus?.configured && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <h3 style={{ fontSize: '12px', marginBottom: '6px', color: 'var(--text-primary)' }}>
            ⚠ Gmail 通知の設定が必要です
          </h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            プロジェクトルートの <code>.env.local</code> に以下を追加してください:<br />
            <code style={{ display: 'block', marginTop: '6px', padding: '6px', background: 'var(--bg-void)', borderRadius: '2px' }}>
              GMAIL_USER=your_gmail@gmail.com<br />
              GMAIL_APP_PASSWORD=your_app_password
            </code>
            アプリパスワードは Google アカウント設定の「アプリパスワード」から生成できます。
          </p>
        </div>
      )}
    </div>
  )
}

function StatusCard({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div className="card" style={{ padding: '10px 12px' }}>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 600, color: color ?? 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>
    </div>
  )
}

const headStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '11px',
}
