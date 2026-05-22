// components/hex/TransitionMatrixMock.tsx
// モック準拠 sb-mx グリッド (34px ヘッダー列 + 6 等幅、teal opacity 背景、対角線は灰色)

import { getTransitionMatrix, type Timescale, type Period } from '@/lib/queries/hex'

export async function TransitionMatrixMock({ timescale, period }: { timescale: Timescale; period: Period }) {
  const cells = await getTransitionMatrix(timescale, period)
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0)
  const get = (from: number, to: number) =>
    cells.find(c => c.from_stage === from && c.to_stage === to)?.count ?? 0

  const total = cells.reduce((a, c) => a + c.count, 0)
  const top = [...cells].sort((a, b) => b.count - a.count)[0]
  const bigJump = cells
    .filter(c => Math.abs(c.from_stage - c.to_stage) >= 3 && c.count > 0)
    .sort((a, b) => b.count - a.count)[0]

  return (
    <div>
      <div className="sb-hd">
        <h2 className="sb-h2-sm">遷移マトリクス FROM → TO</h2>
        <span>セル色濃さ = 件数 · 合計 {total.toLocaleString()} 件</span>
      </div>
      <div className="sb-mx">
        <div className="sb-mx-h"></div>
        {[1, 2, 3, 4, 5, 6].map(s => (
          <div key={`th-${s}`} className="sb-mx-h">→{s}</div>
        ))}
        {[1, 2, 3, 4, 5, 6].map(from => (
          <Row key={`row-${from}`} from={from} get={get} max={max} />
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
        {top && top.count > 0 && (
          <div>
            最大流量:{' '}
            <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>
              {top.from_stage} → {top.to_stage} ({top.count.toLocaleString()} 件)
            </span>
          </div>
        )}
        {bigJump && (
          <div>
            注目: 大ジャンプ{' '}
            <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>
              {bigJump.from_stage} → {bigJump.to_stage}
            </span>{' '}
            ({bigJump.count.toLocaleString()} 件)
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ from, get, max }: { from: number; get: (from: number, to: number) => number; max: number }) {
  return (
    <>
      <div className="sb-mx-h">{from}→</div>
      {[1, 2, 3, 4, 5, 6].map(to => {
        const isDiag = from === to
        const n = get(from, to)
        if (isDiag) {
          return (
            <div key={`cell-${from}-${to}`} className="sb-mx-diag">−</div>
          )
        }
        const intensity = max > 0 ? n / max : 0
        const opacity = n > 0 ? 0.10 + intensity * 0.70 : 0
        return (
          <div
            key={`cell-${from}-${to}`}
            style={{
              background: n > 0 ? `rgba(15, 110, 86, ${opacity.toFixed(2)})` : undefined,
              color: opacity > 0.5 ? '#085041' : undefined,
              fontWeight: opacity > 0.5 ? 500 : undefined,
            }}
            title={`${from}→${to}: ${n}`}
          >
            {n > 0 ? n : ''}
          </div>
        )
      })}
    </>
  )
}
