// lib/gmail-notify.ts
import nodemailer from 'nodemailer'
import type { Alert } from '@/types/alert'

interface AlertMailOptions {
  to: string
  alerts: Alert[]
  type: 'REALTIME' | 'DAILY_SUMMARY'
}

function createTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  })
}

function getConditionLabel(alert: Alert): string {
  const c = alert.condition
  switch (c.type) {
    case 'PRICE_ABOVE':    return `株価 ${c.threshold.toLocaleString()} 以上`
    case 'PRICE_BELOW':    return `株価 ${c.threshold.toLocaleString()} 以下`
    case 'MA_ORDER':       return c.order === 'BULLISH' ? 'MA上昇配列' : 'MA下降配列'
    case 'GOLDEN_CROSS':   return `ゴールデンクロス (MA${c.shortPeriod}/MA${c.longPeriod})`
    case 'DEAD_CROSS':     return `デッドクロス (MA${c.shortPeriod}/MA${c.longPeriod})`
    case 'MACD_GOLDEN_CROSS': return 'MACDゴールデンクロス'
    case 'MACD_DEAD_CROSS':   return 'MACDデッドクロス'
    default: return '不明な条件'
  }
}

function buildRealtimeHtml(alerts: Alert[]): string {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  const alertRows = alerts.map(alert => {
    const ticker = alert.condition.ticker
    const label = getConditionLabel(alert)
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })

    return `
      <tr style="border-bottom: 1px solid #1e293b;">
        <td style="padding: 12px 16px; font-family: monospace; color: #f5a623;">${ticker}</td>
        <td style="padding: 12px 16px; color: #e8edf5;">${label}</td>
        <td style="padding: 12px 16px; color: #8899b0; font-size: 12px;">${now}</td>
        <td style="padding: 12px 16px;">
          <a href="${baseUrl}/stock/${encodeURIComponent(ticker)}"
             style="color: #f5a623; text-decoration: none; font-size: 12px; border: 1px solid #f5a623; padding: 3px 8px; border-radius: 2px;">
            チャートを確認 →
          </a>
        </td>
      </tr>
    `
  }).join('')

  return `
    <!DOCTYPE html>
    <html>
    <body style="margin: 0; padding: 0; background: #030508; font-family: 'IBM Plex Sans JP', sans-serif;">
      <div style="max-width: 640px; margin: 0 auto; padding: 24px;">
        <!-- ヘッダー -->
        <div style="border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px;">
          <span style="font-family: monospace; font-size: 20px; font-weight: 700; color: #f5a623;">SB</span>
          <span style="color: #8899b0; margin-left: 8px;">StockBoard アラート通知</span>
        </div>

        <h1 style="color: #e8edf5; font-size: 16px; margin: 0 0 16px;">
          🔔 株価アラート: ${alerts.length}件の条件が合致しました
        </h1>

        <table style="width: 100%; border-collapse: collapse; background: #0d1520; border: 1px solid #1e293b; border-radius: 4px;">
          <thead>
            <tr style="background: #111c2d; border-bottom: 1px solid #1e293b;">
              <th style="padding: 10px 16px; text-align: left; color: #4a5a70; font-size: 11px; letter-spacing: 0.08em;">銘柄</th>
              <th style="padding: 10px 16px; text-align: left; color: #4a5a70; font-size: 11px; letter-spacing: 0.08em;">条件</th>
              <th style="padding: 10px 16px; text-align: left; color: #4a5a70; font-size: 11px; letter-spacing: 0.08em;">検知時刻</th>
              <th style="padding: 10px 16px; text-align: left; color: #4a5a70; font-size: 11px; letter-spacing: 0.08em;">リンク</th>
            </tr>
          </thead>
          <tbody>
            ${alertRows}
          </tbody>
        </table>

        <div style="margin-top: 24px; padding: 12px; background: #0d1520; border: 1px solid #1e293b; border-radius: 4px;">
          <p style="color: #4a5a70; font-size: 11px; margin: 0;">
            このメールはStockBoardの自動アラートシステムから送信されました。<br>
            アラート設定の変更: <a href="${baseUrl}/alerts" style="color: #f5a623;">${baseUrl}/alerts</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `
}

function buildDailySummaryHtml(alerts: Alert[]): string {
  const today = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric' })
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'

  const alertRows = alerts.map(alert => {
    const ticker = alert.condition.ticker
    const label = getConditionLabel(alert)
    const triggered = alert.lastTriggeredAt
      ? new Date(alert.lastTriggeredAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
      : '--:--'

    return `
      <tr style="border-bottom: 1px solid #1e293b;">
        <td style="padding: 10px 16px; font-family: monospace; color: #f5a623;">${ticker}</td>
        <td style="padding: 10px 16px; color: #e8edf5;">${label}</td>
        <td style="padding: 10px 16px; color: #8899b0; font-family: monospace;">${triggered}</td>
      </tr>
    `
  }).join('')

  return `
    <!DOCTYPE html>
    <html>
    <body style="margin: 0; padding: 0; background: #030508; font-family: 'IBM Plex Sans JP', sans-serif;">
      <div style="max-width: 640px; margin: 0 auto; padding: 24px;">
        <div style="border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px;">
          <span style="font-family: monospace; font-size: 20px; font-weight: 700; color: #f5a623;">SB</span>
          <span style="color: #8899b0; margin-left: 8px;">StockBoard 日次サマリー</span>
        </div>

        <h1 style="color: #e8edf5; font-size: 16px; margin: 0 0 16px;">
          📊 ${today} のアラートサマリー
        </h1>
        <p style="color: #8899b0; font-size: 12px; margin: 0 0 20px;">
          本日発生したアラート: ${alerts.length}件
        </p>

        <table style="width: 100%; border-collapse: collapse; background: #0d1520; border: 1px solid #1e293b; border-radius: 4px;">
          <thead>
            <tr style="background: #111c2d; border-bottom: 1px solid #1e293b;">
              <th style="padding: 10px 16px; text-align: left; color: #4a5a70; font-size: 11px; letter-spacing: 0.08em;">銘柄</th>
              <th style="padding: 10px 16px; text-align: left; color: #4a5a70; font-size: 11px; letter-spacing: 0.08em;">条件</th>
              <th style="padding: 10px 16px; text-align: left; color: #4a5a70; font-size: 11px; letter-spacing: 0.08em;">発火時刻</th>
            </tr>
          </thead>
          <tbody>${alertRows}</tbody>
        </table>

        <div style="margin-top: 24px;">
          <a href="${baseUrl}/alerts"
             style="display: inline-block; padding: 10px 20px; background: #f5a623; color: #000; text-decoration: none; font-size: 12px; font-weight: 600; border-radius: 2px;">
            アラート設定を確認する →
          </a>
        </div>
      </div>
    </body>
    </html>
  `
}

export async function sendAlertMail(options: AlertMailOptions): Promise<void> {
  const { to, alerts, type } = options

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('Gmail環境変数が設定されていません (GMAIL_USER, GMAIL_APP_PASSWORD)')
  }

  if (alerts.length === 0) return

  const transporter = createTransport()

  const subject = type === 'REALTIME'
    ? `🔔 StockBoard アラート: ${alerts.length}件の条件が合致`
    : `📊 StockBoard 日次サマリー: ${alerts.length}件のアラート発生`

  const html = type === 'REALTIME'
    ? buildRealtimeHtml(alerts)
    : buildDailySummaryHtml(alerts)

  await transporter.sendMail({
    from: `StockBoard <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  })
}

export async function testMailConnection(): Promise<boolean> {
  try {
    const transporter = createTransport()
    await transporter.verify()
    return true
  } catch {
    return false
  }
}
