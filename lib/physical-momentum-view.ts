export type PhysicalMomentumTone = 'up' | 'down' | 'warning' | 'neutral'
export type PhysicalMomentumTrend = 'rising' | 'falling' | 'flat' | null

export interface PhysicalMomentumViewInput {
  pms?: number | null
  pfs?: number | null
  pes?: number | null
  trend?: PhysicalMomentumTrend
  rank?: number | null
  total?: number | null
  fieldLabel?: string | null
}

export interface PhysicalMomentumCheck {
  label: string
  text: string
  tone: PhysicalMomentumTone
}

export interface PhysicalMomentumView {
  tone: PhysicalMomentumTone
  label: string
  stance: string
  summary: string
  primaryAction: string
  avoid: string
  risk: string
  badges: string[]
  checks: PhysicalMomentumCheck[]
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function fmtScore(value: number | null | undefined): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

function rankBadge(rank: number | null | undefined, total: number | null | undefined): string | null {
  if (!rank || !total || !Number.isFinite(rank) || !Number.isFinite(total) || total <= 0) return null
  const pct = Math.max(1, Math.min(100, Math.round((rank / total) * 100)))
  if (pct <= 50) return `市場上位 ${pct}%`
  return `市場下位 ${Math.max(1, 101 - pct)}%`
}

export function buildPhysicalMomentumView(input: PhysicalMomentumViewInput): PhysicalMomentumView {
  const pms = input.pms
  const pfs = input.pfs
  const pes = input.pes
  const trend = input.trend
  const fieldLabel = input.fieldLabel ?? ''
  const strongPms = finite(pms) && pms >= 1
  const weakPms = finite(pms) && pms <= -1
  const forceUp = finite(pfs) && pfs >= 0.35
  const forceDown = finite(pfs) && pfs <= -0.35
  const highEnergy = finite(pes) && pes >= 1
  const lowEnergy = finite(pes) && pes <= -0.35
  const trendDown = trend === 'falling'
  const trendUp = trend === 'rising'
  const fieldDown = fieldLabel.includes('下方向') || fieldLabel.includes('短期調整')
  const fieldUp = fieldLabel.includes('上方向')
  const fieldCompression = fieldLabel.includes('収縮') || fieldLabel.includes('ねじれ')

  let tone: PhysicalMomentumTone = 'neutral'
  let label = '方向待ち'
  let stance = '決め打ちせず、力の向きが揃うまで待つ'
  let summary = 'PMSは単独では売買判断にしません。PFS、PES、MA力場の向きが同じ方向へ揃うかを確認します。'
  let primaryAction = '終値が短期線のどちら側で安定するか、PFSが上下どちらへ傾くかを待ちます。'
  let avoid = 'PMSだけを見て高値追い/安値拾いを決めないでください。'
  let risk = '方向感が弱いときは、短期の上下振れで判断がぶれやすい状態です。'

  if (strongPms && forceUp && !trendDown) {
    tone = highEnergy ? 'warning' : 'up'
    label = highEnergy ? '強いが過熱も確認' : '上向き継続を確認'
    stance = '押し目が浅いなら継続監視'
    summary = '総合の力と短期の力が同じ上方向です。次はこの力がMA力場の長期側へ伝わるかを見ます。'
    primaryAction = '高値更新時にPFSが落ちず、5MA/25MA上で終値が残るかを確認します。'
    avoid = highEnergy ? '熱量が高いため、上髭や急なPFS低下が出た高値追いは避けます。' : '出来高やPFSが伴わない上抜けだけで追いかけないでください。'
    risk = highEnergy ? '強さと同時に過熱もあります。PESが急低下すると反落に変わりやすいです。' : 'PFSがマイナス化すると、上方向の力が一時的に途切れます。'
  } else if (strongPms && (forceDown || trendDown)) {
    tone = 'warning'
    label = '強いが短期冷却'
    stance = '追わずに下げ止まり待ち'
    summary = '総合の強さは残っていますが、短期の力は低下しています。上昇トレンドの押し目か、過熱終了かの分岐です。'
    primaryAction = '5MA/25MA付近で下げ止まり、PFSが再びプラスへ戻るかを確認します。'
    avoid = 'PMSが高いだけで高値追いしないでください。短期の力が戻る前の買い増しは慎重です。'
    risk = 'PFS低下が続くと、強い銘柄でも短期の反落が深くなります。'
  } else if (weakPms && forceDown) {
    tone = 'down'
    label = '下向き優勢'
    stance = '反発買いより戻りの弱さを確認'
    summary = '総合の力も短期の力も下方向です。反発を取りに行くより、下向きの力が止まる証拠を優先します。'
    primaryAction = '25MA回復、PFSのマイナス縮小、安値切り上げが揃うまで待ちます。'
    avoid = '値ごろ感だけの逆張りは避けます。戻りが弱い場合は下落継続を優先します。'
    risk = '下方向の力が長期側へ拡散すると、反発が一時的になりやすいです。'
  } else if (weakPms && forceUp) {
    tone = 'neutral'
    label = '弱いが反発準備'
    stance = '小さく観察、反転確認待ち'
    summary = '総合ではまだ弱い一方、短期の力は戻り始めています。下落途中の一時反発か、本格反転かを分けて見ます。'
    primaryAction = 'PFSプラスが続き、PMSが改善方向へ転じるかを確認します。'
    avoid = 'PMSが弱いままの大きな買いは避けます。反発初期は失速しやすいです。'
    risk = '25MAや75MA付近で戻りが止まると、再び下方向へ傾きやすいです。'
  } else if (!weakPms && !strongPms && forceUp) {
    tone = 'up'
    label = '初動の芽'
    stance = '候補として監視'
    summary = '総合の力はまだ中立ですが、短期の力が先に上向いています。初動候補として、PMSへの波及を待つ局面です。'
    primaryAction = 'PFSプラスが続き、PMSが0から+側へ抜けるかを確認します。'
    avoid = '初動だけで大きく張らず、6ステージ改善やMA力場の上向き化を待ちます。'
    risk = 'PFSだけの一過性反発なら、数日で失速しやすいです。'
  } else if (!weakPms && !strongPms && forceDown) {
    tone = 'warning'
    label = '初動失速'
    stance = '買い急がず様子見'
    summary = '総合の力は中立ですが、短期の力は下向きです。上昇よりも失速・下抜けの確認を優先します。'
    primaryAction = 'PFSのマイナス縮小、終値の短期線回復、出来高を伴う反発を待ちます。'
    avoid = '下向きの力が残る間は、反発一本で追いかけないでください。'
    risk = '中立圏から下方向へPMSが崩れると、弱含みへ移行します。'
  } else if (highEnergy) {
    tone = 'warning'
    label = '熱量は高いが方向待ち'
    stance = '上下どちらへ熱量が出るか確認'
    summary = '値動きの熱量はありますが、PMS/PFSの方向が明確ではありません。抜け方向を確認してから判断します。'
    primaryAction = '上抜けならPFS維持、下抜けならPFSマイナス拡大を確認します。'
    avoid = '方向がない高ボラだけで売買判断しないでください。'
    risk = '熱量があるため、反対方向へ動いたときの振れ幅も大きくなりやすいです。'
  } else if (lowEnergy) {
    tone = 'neutral'
    label = '熱量不足'
    stance = '材料待ち'
    summary = '値動きの熱量が不足しています。反転やブレイクには、PFSと出来高の改善が必要です。'
    primaryAction = '出来高増加、PFS改善、MA力場の拡散方向を待ちます。'
    avoid = '動きが乏しい状態で無理に方向を決めないでください。'
    risk = '薄い反発や小幅な下げは、だましになりやすいです。'
  }

  if (fieldDown && tone === 'up') {
    tone = 'warning'
    label = `${label} / 上位の重さあり`
    risk = 'MA力場は下向き要素を含みます。短期の反発が長期線で止まる可能性があります。'
  } else if (fieldUp && tone === 'down') {
    tone = 'warning'
    label = `${label} / 長期の支えあり`
    risk = '長期側には上向きの力が残ります。売り方向は反発リスクも確認してください。'
  } else if (fieldCompression) {
    primaryAction = `${primaryAction} 併せて、収縮後に上/下どちらへ力場が拡散するかを見ます。`
  }

  const badges = [
    `PMS ${fmtScore(pms)}`,
    `PFS ${fmtScore(pfs)}`,
    `PES ${fmtScore(pes)}`,
    trendUp ? 'PMS改善中' : trendDown ? 'PMS低下中' : trend === 'flat' ? 'PMS横ばい' : null,
    rankBadge(input.rank, input.total),
    fieldLabel || null,
  ].filter((item): item is string => Boolean(item))

  const checks: PhysicalMomentumCheck[] = [
    { label: '今の姿勢', text: stance, tone },
    { label: '確認条件', text: primaryAction, tone },
    { label: '避けること', text: avoid, tone: tone === 'down' ? 'down' : 'warning' },
    { label: 'リスク', text: risk, tone: tone === 'up' ? 'warning' : tone },
  ]

  return { tone, label, stance, summary, primaryAction, avoid, risk, badges, checks }
}
