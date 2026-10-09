import { useState } from 'react'
import { AppError, errorMessage } from '../lib/errors'
import { dateJa, signedYen, yen } from '../lib/format'
import { denomsPayload, denomsTotal, type DenomCounts } from '../lib/money'
import { useApp } from '../store'
import { DenomCounter } from './DenomCounter'

/** 営業開始(釣銭登録) / レジ締め(金種別の枚数入力 → 理論残高との過不足) */
export function DayControl() {
  const { snapshot, api, toast } = useApp()
  const day = snapshot!.day
  const balance = snapshot!.balance ?? 0
  const [counts, setCounts] = useState<DenomCounts>({})
  const [amount, setAmount] = useState('')
  const [useCounter, setUseCounter] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function open() {
    setBusy(true)
    setError(null)
    try {
      if (useCounter) {
        const total = denomsTotal(counts)
        await api.openDay(denomsPayload(counts), null)
        toast(`営業を開始しました(釣銭 ${yen(total)})`, 'ok')
      } else {
        const n = Number(amount.replace(/[^0-9]/g, ''))
        await api.openDay(null, n)
        toast(`営業を開始しました(釣銭 ${yen(n)})`, 'ok')
      }
      setCounts({})
      setAmount('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function close(force = false): Promise<void> {
    if (!day) return
    setBusy(true)
    setError(null)
    try {
      const r = (await api.closeDay(day.id, denomsPayload(counts), note.trim() || null, force)) as { variance: number }
      toast(`営業を終了しました(過不足 ${signedYen(r.variance)})`, 'ok')
      setCounts({})
      setNote('')
    } catch (e) {
      if (e instanceof AppError && e.code === 'unserved_orders' && !force) {
        if (window.confirm(`未提供の注文が${e.detail}件あります。このまま営業を終了しますか?`)) {
          setBusy(false)
          return close(true)
        }
      } else {
        setError(errorMessage(e))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!day) {
    const startDisabled = busy || (useCounter ? denomsTotal(counts) === 0 : amount === '')
    return (
      <div className="card stack">
        <div className="h2">営業開始(釣銭の登録)</div>
        <div className="seg" role="group" aria-label="入力方法">
          <button aria-pressed={useCounter} onClick={() => setUseCounter(true)}>金種ごとに入力</button>
          <button aria-pressed={!useCounter} onClick={() => setUseCounter(false)}>合計金額で入力</button>
        </div>
        {useCounter ? (
          <DenomCounter counts={counts} onChange={setCounts} />
        ) : (
          <label className="field">
            釣銭の合計金額(円)
            <input
              className="input num"
              inputMode="numeric"
              pattern="[0-9]*"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))}
            />
          </label>
        )}
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn primary block" disabled={startDisabled} onClick={() => void open()}>
          {busy ? '処理中…' : '営業を開始する'}
        </button>
        <p className="hint" style={{ margin: 0 }}>注文番号は営業日ごとに 001 から発行されます。</p>
      </div>
    )
  }

  const counted = denomsTotal(counts)
  const variance = counted - balance
  return (
    <div className="card stack">
      <div className="row between">
        <div className="h2">営業中: {dateJa(day.business_date)}</div>
        <span className="chip good">営業中</span>
      </div>
      <div className="hint">開始 {day.opened_by_name ?? ''} / 釣銭 {yen(day.opening_float)}</div>
      {(
        <>
          <div className="h3" style={{ margin: 0 }}>レジ締め(現金箱の実際の枚数を入力)</div>
          <DenomCounter counts={counts} onChange={setCounts} />
          <div className="kv"><span>理論現金残高</span><span className="v">{yen(balance)}</span></div>
          <div className="kv"><span>実際の現金</span><span className="v">{yen(counted)}</span></div>
          <div className="kv">
            <span style={{ fontWeight: 700 }}>過不足</span>
            <span className={`v ${variance === 0 ? 'good' : 'warn'}`} style={{ fontSize: '1.4rem' }}>
              {counted === 0 ? '—' : signedYen(variance)}
            </span>
          </div>
          <label className="field">
            メモ(任意)
            <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例: 100円玉が不足" />
          </label>
          {error && <div className="err" role="alert">{error}</div>}
          <button
            className="btn danger block"
            disabled={busy || counted === 0}
            onClick={() => {
              if (window.confirm(`営業を終了してレジを締めます。\n理論残高 ${yen(balance)} / 実際 ${yen(counted)} / 過不足 ${signedYen(variance)}\nよろしいですか?`)) void close()
            }}
          >
            {busy ? '処理中…' : '営業を終了してレジを締める'}
          </button>
        </>
      )}
    </div>
  )
}
