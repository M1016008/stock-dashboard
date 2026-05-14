import { STAGE_BG_COLORS, STAGE_BORDER_COLORS } from '@/lib/hex-stage'

interface HexStructureVizProps {
  stages: [number, number, number, number, number, number]
}

const AXIS_LABELS = ['日足A', '日足B', '週足A', '週足B', '月足A', '月足B']

/**
 * 6 軸 (日A日B週A週B月A月B) ごとの現ステージを、6 つの小さな HEX サイクルで可視化。
 * サイクル上の頂点をステージ 1〜6 として配置、現在ステージをハイライト。
 */
export function HexStructureViz({ stages }: HexStructureVizProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {stages.map((stage, i) => (
        <MiniHexCycle key={i} label={AXIS_LABELS[i]} currentStage={stage} />
      ))}
    </div>
  )
}

function MiniHexCycle({
  label,
  currentStage,
}: {
  label: string
  currentStage: number
}) {
  const size = 100
  const cx = size / 2
  const cy = size / 2
  const r = 32
  // ステージ 1〜6 を頂点に配置 (時計回り、ステージ1 = 12時)
  const angles = [90, 30, -30, -90, -150, 150]
  const points = angles.map((a, i) => {
    const rad = (a * Math.PI) / 180
    return {
      stage: i + 1,
      x: cx + r * Math.cos(rad),
      y: cy - r * Math.sin(rad),
    }
  })

  return (
    <div className="rounded border border-[var(--color-border-soft)] p-2">
      <div className="mb-1 text-center text-[10px] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto h-20 w-20">
        {/* サイクル外周 */}
        <polygon
          points={points.map(p => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="var(--color-border-default)"
          strokeWidth={0.5}
        />
        {points.map(p => {
          const isCurrent = p.stage === currentStage
          return (
            <g key={p.stage}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isCurrent ? 10 : 6}
                fill={STAGE_BG_COLORS[p.stage]}
                stroke={STAGE_BORDER_COLORS[p.stage]}
                strokeWidth={isCurrent ? 2 : 1}
              />
              <text
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={isCurrent ? 10 : 7}
                fill={STAGE_BORDER_COLORS[p.stage]}
                fontWeight={isCurrent ? 'bold' : 'normal'}
              >
                {p.stage}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
