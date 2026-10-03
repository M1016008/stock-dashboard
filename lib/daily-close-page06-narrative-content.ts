import {
  MOMENTUM_STATE_LABEL,
  MOMENTUM_STATE_RULE,
  SPOTLIGHT_ORDER,
  formatPct,
  round1,
  winRatePct,
  type MomentumMatrixModel,
} from '@/lib/daily-close-momentum-matrix'

// Page 06 Design Lab「Narrative」層 (pure)。
// - Claude に渡す JSON の組み立て
// - Claude 出力の検証 (スキーマ・文字数・数値・分類名・禁止語)
// - deterministic fallback 文章
// Claude の呼び出し自体は lib/server/daily-close-page06-narrative.ts。

export function buildPage06ClaudeInput(model: MomentumMatrixModel) {
  return {
    reportDate: model.reportDate,
    definitions: {
      momentumShift: 'rank1M - rank1W。正は順位上昇。リターンの加速度ではない',
      rankBasis: '60分類の平均リターン順位(1=最上位)',
      states: Object.fromEntries(SPOTLIGHT_ORDER.map((state) => [MOMENTUM_STATE_LABEL[state], MOMENTUM_STATE_RULE[state]])),
      meanDriven: '1W平均>0だが中央値≤0または勝率<50%',
    },
    stateCounts: {
      上位維持: model.counts.LEADER,
      急浮上: model.counts.EMERGING,
      高位失速: model.counts.FADING,
      下位改善: model.counts.RECOVERING,
      その他: model.counts.NEUTRAL,
      lowSample: model.lowSampleCount,
    },
    featured: model.spotlight.map((point) => ({
      state: MOMENTUM_STATE_LABEL[point.state],
      name: point.name,
      rank1M: point.rank1M,
      rank1W: point.rank1W,
      momentumShift: point.momentumShift,
      oneWeek: { meanPct: round1(point.oneWeek.mean), medianPct: round1(point.oneWeek.median), winRatePct: winRatePct(point.oneWeek.winRate) },
      oneMonth: { meanPct: round1(point.oneMonth.mean) },
      meanDriven: point.meanDriven,
    })),
  }
}

export type Page06ClaudeInput = ReturnType<typeof buildPage06ClaudeInput>

export type Page06Narrative = { headline: string; fact: string; interpretation: string; caveat: string }

export const PAGE06_HEADLINE_MAX = 40
export const PAGE06_LINE_MAX = 120
const PAGE06_KEYS = ['headline', 'fact', 'interpretation', 'caveat'] as const
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/
const FORBIDDEN_WORDS = /推奨|買い|売り|予想|予測|見通し|目標/
const NUMBER_TOKEN = /\d+(?:\.\d+)?/g

function numbersIn(text: string): number[] {
  return (text.match(NUMBER_TOKEN) ?? []).map(Number)
}

export function validatePage06Narrative(
  value: unknown,
  input: Page06ClaudeInput,
  allNames: readonly string[],
): { ok: true; narrative: Page06Narrative } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not_object' }
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => !(PAGE06_KEYS as readonly string[]).includes(key))
  if (extra.length) return { ok: false, reason: `extra_keys:${extra.slice(0, 3).join(',')}` }

  const narrative = {} as Page06Narrative
  for (const key of PAGE06_KEYS) {
    const raw = record[key]
    if (typeof raw !== 'string') return { ok: false, reason: `${key}_not_string` }
    const text = raw.trim()
    if (!text) return { ok: false, reason: `${key}_empty` }
    if (text.length > (key === 'headline' ? PAGE06_HEADLINE_MAX : PAGE06_LINE_MAX)) return { ok: false, reason: `${key}_too_long` }
    if (CONTROL_CHARS.test(text)) return { ok: false, reason: `${key}_control_chars` }
    if (FORBIDDEN_WORDS.test(text)) return { ok: false, reason: `${key}_forbidden_word` }
    narrative[key] = text
  }

  // 出力中の数値はすべて入力 JSON 由来であること (符号は表記揺れとして無視)
  const allowed = new Set(numbersIn(JSON.stringify(input)))
  const combined = PAGE06_KEYS.map((key) => narrative[key]).join('\n')
  const unknownNumber = numbersIn(combined).find((number) => !allowed.has(number))
  if (unknownNumber != null) return { ok: false, reason: `number_not_in_input:${unknownNumber}` }

  // 分類名は featured のみ。長い名前から先に除去して部分一致の誤検出を避ける
  const featured = input.featured.map((item) => item.name).sort((a, b) => b.length - a.length)
  let remaining = combined
  for (const name of featured) remaining = remaining.split(name).join('')
  const foreign = allNames.find((name) => remaining.includes(name))
  if (foreign) return { ok: false, reason: 'non_featured_classification' }

  return { ok: true, narrative }
}

export function deterministicPage06Narrative(model: MomentumMatrixModel): Page06Narrative {
  const { LEADER: leader, EMERGING: emerging, FADING: fading, RECOVERING: recovering } = model.counts
  const topEmerging = model.lists.EMERGING[0]
  const topFading = model.lists.FADING[0]

  const headlineCandidates: string[] = []
  if (emerging && fading) {
    if (topEmerging?.momentumShift != null) headlineCandidates.push(`急浮上${emerging}・高位失速${fading}分類、${topEmerging.name}が${topEmerging.momentumShift}位上昇`)
    headlineCandidates.push(`急浮上${emerging}・高位失速${fading}分類`)
  } else if (emerging) {
    if (topEmerging) headlineCandidates.push(`急浮上${emerging}分類、${topEmerging.name}が1M#${topEmerging.rank1M}→1W#${topEmerging.rank1W}`)
    headlineCandidates.push(`急浮上${emerging}分類`)
  } else if (fading) {
    if (topFading) headlineCandidates.push(`高位失速${fading}分類、${topFading.name}が1M#${topFading.rank1M}→1W#${topFading.rank1W}`)
    headlineCandidates.push(`高位失速${fading}分類`)
  } else {
    headlineCandidates.push(`上位維持${leader}分類、大きな順位変化は限定的`)
  }
  const headline = headlineCandidates.find((text) => text.length <= PAGE06_HEADLINE_MAX) ?? headlineCandidates.at(-1)!.slice(0, PAGE06_HEADLINE_MAX)

  const lead = model.spotlight[0]
  const fact = `上位維持${leader}・急浮上${emerging}・高位失速${fading}・下位改善${recovering}分類。`
    + (lead ? `注目首位は${lead.name}（1M#${lead.rank1M}→1W#${lead.rank1W}、1W平均${formatPct(lead.oneWeek.mean)}）。` : '')

  const rising = emerging + recovering
  const interpretation = rising === fading
    ? `1M下位からの順位上昇（${rising}分類）は高位からの失速（${fading}分類）と拮抗。`
    : `1M下位からの順位上昇（${rising}分類）が高位からの失速（${fading}分類）を${rising > fading ? '上回る' : '下回る'}。`

  const meanDriven = model.spotlight.filter((point) => point.meanDriven).map((point) => point.name)
  const caveat = [
    '順位は平均リターン基準で、リターンの加速度ではない。',
    meanDriven.length ? `${meanDriven.join('・')}は平均主導（中央値≤0または勝率<50%）。` : '',
    model.lowSampleCount ? `LOW SAMPLE ${model.lowSampleCount}分類は注目対象外。` : '',
  ].join('')

  return { headline, fact, interpretation, caveat }
}
