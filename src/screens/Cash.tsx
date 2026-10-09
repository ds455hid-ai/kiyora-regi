import { useRef, useState } from 'react'
import { DayControl } from '../components/DayControl'
import { errorMessage } from '../lib/errors'
import { dateTimeJa, signedYen, yen } from '../lib/format'
import { newRequestId } from '../lib/pending'
import type { CashKind } from '../lib/types'
import { useApp } from '../store'

const KIND_LABEL: Record<CashKind, string> = {
  opening: '開始釣銭',
  sale: '現金売上',
  refund: '返金',
  replenish: '補充',
  collect: '回収',
}

export function Cash() {
  const { snapshot, api, toast } = useApp()
  const isAdmin = snapshot!.me!.role === 'admin'
  const day = snapshot!.day
  const balance = snapshot!.balance ?? 0
  const totals = snapshot!.cash_totals ?? {}
  const events = snapshot!.cash_events ?? []

  const [kind, setKind] = useState<'replenish' | 'collect'>('replenish')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(newRequestId())

  async function submit() {
    const n = Number(amount)
    if (!n || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.recordCash(requestId.current, kind, n, note.trim() || null)
      requestId.current = newRequestId()
      toast(`${kind === 'replenish' ? '補充' : '回収'}を記録しました(残高 ${yen(r.balance)})`, 'ok')
      setAmount('')
      setNote('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <div className="stack">
        {day && (
          <div className="card">
            <h3>現在の理論現金残高</h3>
            <div className="bigbal">{yen(balance)}</div>
            <div style={{ marginTop: 8 }}>
              {(['opening', 'sale', 'refund', 'replenish', 'collect'] as CashKind[]).map((k) => (
                <div className="kv" key={k}>
                  <span>{KIND_LABEL[k]}</span>
                  <span className={`v ${(totals[k] ?? 0) < 0 ? 'warn' : ''}`}>{signedYen(totals[k] ?? 0)}</span>
                </div>
              ))}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>開始釣銭 + 現金売上 − 返金 + 補充 − 回収 = 理論残高(データベースで集計)</div>
          </div>
        )}

        {day && isAdmin && (
          <div className="card stack">
            <h3 style={{ margin: 0 }}>現金の補充・回収</h3>
            <div className="seg" role="group" aria-label="種類">
              <button aria-pressed={kind === 'replenish'} onClick={() => setKind('replenish')}>補充(釣銭を足す)</button>
              <button aria-pressed={kind === 'collect'} onClick={() => setKind('collect')}>回収(売上を抜く)</button>
            </div>
            <label className="field">
              金額(円)
              <input className="input num" inputMode="numeric" pattern="[0-9]*" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))} />
            </label>
            <label className="field">
              メモ(任意)
              <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </label>
            {error && <div className="err" role="alert">{error}</div>}
            <button className="btn primary block" disabled={busy || !Number(amount)} onClick={() => void submit()}>
              {busy ? '処理中…' : kind === 'replenish' ? '補充を記録' : '回収を記録'}
            </button>
          </div>
        )}

        <DayControl />

        {day && (
          <div className="card">
            <h3>現金の動き(新しい順)</h3>
            <div className="list">
              {events.length === 0 && <div className="muted">まだありません</div>}
              {events.map((e) => (
                <div className="li" key={e.id}>
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{KIND_LABEL[e.kind]}{e.note ? ` — ${e.note}` : ''}</div>
                    <div className="muted" style={{ fontSize: '0.75rem' }}>{e.staff_name ?? ''} {dateTimeJa(e.created_at)}</div>
                  </div>
                  <span className={`num ${e.amount < 0 ? 'warn' : ''}`} style={{ fontWeight: 900 }}>{signedYen(e.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
