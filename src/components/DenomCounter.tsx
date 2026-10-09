import type { Dispatch, SetStateAction } from 'react'
import { DENOMS, denomsTotal, type DenomCounts } from '../lib/money'
import { yen } from '../lib/format'

const clamp = (n: number) => Math.max(0, Math.min(100000, Math.floor(n) || 0))

export function DenomCounter({ counts, onChange }: { counts: DenomCounts; onChange: Dispatch<SetStateAction<DenomCounts>> }) {
  // 連続タップでも取りこぼさないよう、常に最新の state から更新する
  const update = (d: number, fn: (n: number) => number) => onChange((c) => ({ ...c, [d]: clamp(fn(c[d] ?? 0)) }))
  return (
    <div>
      {DENOMS.map((d) => (
        <div className="denom" key={d}>
          <span className="d">{yen(d)}</span>
          <div className="stepper" style={{ justifyContent: 'center' }}>
            <button type="button" aria-label={`${yen(d)}を減らす`} onClick={() => update(d, (n) => n - 1)} disabled={(counts[d] ?? 0) <= 0}>−</button>
            <input
              className="input num"
              inputMode="numeric"
              pattern="[0-9]*"
              style={{ width: 84, minHeight: 42, padding: '6px 4px' }}
              aria-label={`${yen(d)}の枚数`}
              value={counts[d] ?? 0}
              onChange={(e) => update(d, () => Number(e.target.value.replace(/[^0-9]/g, '')))}
              onFocus={(e) => e.target.select()}
            />
            <button type="button" aria-label={`${yen(d)}を増やす`} onClick={() => update(d, (n) => n + 1)}>＋</button>
          </div>
          <span className="num muted" style={{ minWidth: 80, textAlign: 'right' }}>{yen(d * (counts[d] ?? 0))}</span>
        </div>
      ))}
      <div className="kv" style={{ borderTop: '2px solid var(--line)', marginTop: 4 }}>
        <span style={{ fontWeight: 700 }}>合計</span>
        <span className="v" style={{ fontSize: '1.3rem' }}>{yen(denomsTotal(counts))}</span>
      </div>
    </div>
  )
}
