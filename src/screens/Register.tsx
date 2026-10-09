import { useMemo, useState } from 'react'
import { Sheet } from '../components/Sheet'
import { AppError, errorMessage } from '../lib/errors'
import { hm, orderNo, yen } from '../lib/format'
import { backspace, cartTotal, changeOf, MAX_QTY, pressDigit, QUICK_CASH } from '../lib/money'
import { clearPending, loadPending, newRequestId, savePending, type PendingOrder } from '../lib/pending'
import type { Order, Product } from '../lib/types'
import { useApp } from '../store'

const CATEGORY_LABEL = { food: '', drink: 'ドリンク', other: 'その他' } as const
const MAX_RECEIVED = 9_999_999

export function Register({ goto }: { goto: (tab: string) => void }) {
  const { snapshot, api, toast, patchOrder, conn } = useApp()
  const me = snapshot!.me!
  const day = snapshot!.day
  const allProducts = snapshot!.products ?? []
  const products = useMemo(() => allProducts.filter((p) => p.visible), [allProducts])

  const [cart, setCart] = useState<Record<string, number>>({})
  const [received, setReceived] = useState(0)
  const [pending, setPending] = useState<PendingOrder | null>(() => loadPending())
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<Order | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keypad, setKeypad] = useState(false)
  const [typed, setTyped] = useState('0')

  const byId = useMemo(() => new Map(allProducts.map((p) => [p.id, p])), [allProducts])
  const lines = Object.entries(cart)
    .filter(([, q]) => q > 0)
    .map(([id, qty]) => ({ id, qty, product: byId.get(id) }))
  const total = cartTotal(lines.map((l) => ({ price: l.product?.price ?? 0, qty: l.qty })))
  const change = changeOf(total, received)
  const blocked = lines.filter((l) => !l.product || l.product.sold_out || !l.product.visible)
  const locked = pending !== null
  const canConfirm = !!day && lines.length > 0 && blocked.length === 0 && received >= total && total > 0 && !submitting && !locked

  // 連続タップでも取りこぼさないよう、常に最新の state から計算する
  const changeQty = (id: string, d: number) =>
    setCart((c) => {
      const next = Math.max(0, Math.min(MAX_QTY, (c[id] ?? 0) + d))
      const copy = { ...c }
      if (next > 0) copy[id] = next
      else delete copy[id]
      return copy
    })
  const add = (p: Product, d: number) => changeQty(p.id, d)

  const reset = () => {
    setCart({})
    setReceived(0)
    setError(null)
  }

  async function submit(retry?: PendingOrder) {
    if (submitting) return
    let payload = retry
    if (!payload) {
      payload = {
        requestId: newRequestId(),
        items: lines.map((l) => ({ product_id: l.id, qty: l.qty })),
        received,
        total,
        summary: lines.map((l) => `${l.product?.name ?? '?'}×${l.qty}`).join('、'),
        createdAt: Date.now(),
      }
      savePending(payload)
      setPending(payload)
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await api.createOrder(payload.requestId, payload.items, payload.received)
      clearPending()
      setPending(null)
      patchOrder(res.order)
      setDone(res.order)
      reset()
      if (res.duplicate) toast('この会計はすでに登録済みでした(二重登録は防止されました)', 'info')
    } catch (e) {
      if (e instanceof AppError && e.network) {
        setError('通信エラー: この会計が登録されたかどうか確認できていません。電波の良い場所で「再送」を押してください(同じ会計は二重登録されません)')
      } else {
        clearPending()
        setPending(null)
        setError(errorMessage(e))
      }
    } finally {
      setSubmitting(false)
    }
  }

  function discardPending() {
    if (!window.confirm('この会計は登録済みの可能性があります。「受け渡し」画面で注文が登録されていないか確認してから破棄してください。破棄しますか?')) return
    clearPending()
    setPending(null)
    setError(null)
  }

  if (!day) {
    return (
      <div className="screen">
        <div className="card stack">
          <div className="h2">営業が開始されていません</div>
          <p style={{ margin: 0 }}>
            {me.role === 'admin' ? '「管理」画面から営業開始(釣銭の登録)を行ってください。' : '管理者が営業を開始すると会計できるようになります。'}
          </p>
          {me.role === 'admin' && <button className="btn primary" onClick={() => goto('admin')}>管理画面へ</button>}
        </div>
      </div>
    )
  }

  return (
    <div className="reg">
      <div className="reg-scroll">
        <div className="pgrid">
          {products.map((p) => {
            const q = cart[p.id] ?? 0
            return (
              <button
                key={p.id}
                className={`pbtn${q > 0 ? ' selected' : ''}${p.sold_out ? ' soldout' : ''}`}
                disabled={p.sold_out || locked}
                onClick={() => add(p, 1)}
                aria-label={`${p.name} ${yen(p.price)}${p.sold_out ? ' 売り切れ' : ''}${q > 0 ? ` 現在${q}個` : ''}`}
              >
                {q > 0 && <span className="qty">{q}</span>}
                {p.sold_out && <span className="chip warn sold">売切</span>}
                {CATEGORY_LABEL[p.category] && <span className="cat">{CATEGORY_LABEL[p.category]}</span>}
                <span className="pname">{p.name}</span>
                <span className="pprice">{yen(p.price)}</span>
              </button>
            )
          })}
          {products.length === 0 && <div className="card muted" style={{ gridColumn: '1 / -1' }}>商品がありません。管理画面で商品を登録してください。</div>}
        </div>

        {lines.length > 0 && (
          <div className="card cart">
            {lines.map((l) => (
              <div className="cart-row" key={l.id}>
                <div>
                  <div className="nm">{l.product?.name ?? '(削除された商品)'}</div>
                  <div className="sub num">
                    {yen(l.product?.price ?? 0)} × {l.qty} = {yen((l.product?.price ?? 0) * l.qty)}
                    {l.product?.sold_out && <span className="warn"> 売り切れ</span>}
                  </div>
                </div>
                <div className="stepper">
                  <button aria-label={`${l.product?.name}を減らす`} disabled={locked} onClick={() => changeQty(l.id, -1)}>−</button>
                  <span className="n">{l.qty}</span>
                  <button aria-label={`${l.product?.name}を増やす`} disabled={locked || !l.product} onClick={() => l.product && add(l.product, 1)}>＋</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pay">
        {error && <div className="err" role="alert">{error}</div>}
        {pending && (
          <div className="card" style={{ padding: 10, background: 'var(--warn-tint)', borderColor: 'var(--warn)' }}>
            <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>未確認の会計があります: {pending.summary}(合計 {yen(pending.total)})</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary grow" disabled={submitting} onClick={() => void submit(pending)}>{submitting ? '送信中…' : '再送する'}</button>
              <button className="btn sm danger" onClick={discardPending}>破棄</button>
            </div>
          </div>
        )}
        <div className="pay-top">
          <div className="cell"><div className="lb">合計(税込)</div><div className="v">{yen(total)}</div></div>
          <div className="cell"><div className="lb">お預かり</div><div className="v">{yen(received)}</div></div>
          <div className={`cell ${change >= 0 ? 'change' : 'short'}`}>
            <div className="lb">{change >= 0 ? 'おつり' : '不足'}</div>
            <div className="v">{yen(Math.abs(change))}</div>
          </div>
        </div>
        <div className="quick">
          {QUICK_CASH.map((n) => (
            <button key={n} className="btn" disabled={locked} onClick={() => setReceived((r) => Math.min(MAX_RECEIVED, r + n))}>{n.toLocaleString('ja-JP')}</button>
          ))}
          <button className="btn" disabled={locked || total === 0} onClick={() => setReceived(total)}>ぴったり</button>
        </div>
        <div className="row">
          <button className="btn sm grow" disabled={locked} onClick={() => { setTyped('0'); setKeypad(true) }}>数字で入力</button>
          <button className="btn sm grow" disabled={locked || received === 0} onClick={() => setReceived(0)}>預かり訂正</button>
          <button className="btn sm grow danger" disabled={locked || (lines.length === 0 && received === 0)} onClick={reset}>全部取消</button>
        </div>
        <button className="btn primary confirm" disabled={!canConfirm} onClick={() => void submit()}>
          {submitting ? '送信中…' : conn === 'offline' && canConfirm ? '会計確定(通信待ち)' : '会計確定'}
        </button>
      </div>

      {keypad && (
        <Sheet title="お預かり金額を入力" onClose={() => setKeypad(false)}>
          <div className="kdisp">{yen(Number(typed))}</div>
          <div className="muted" style={{ fontSize: '0.8rem' }}>いまのお預かり: {yen(received)}(入力した金額を足します)</div>
          <div className="keypad">
            {['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0'].map((d) => (
              <button key={d} className="btn" onClick={() => setTyped((t) => pressDigit(t, d))}>{d}</button>
            ))}
            <button className="btn danger" aria-label="一文字消す" onClick={() => setTyped((t) => backspace(t))}>⌫</button>
          </div>
          <div className="row">
            <button className="btn grow" onClick={() => setTyped('0')}>クリア</button>
            <button
              className="btn primary grow"
              disabled={Number(typed) === 0}
              onClick={() => {
                setReceived((r) => Math.min(MAX_RECEIVED, r + Number(typed)))
                setKeypad(false)
              }}
            >
              この金額を足す
            </button>
          </div>
        </Sheet>
      )}

      {done && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="会計完了">
          <div className="done">
            <div className="lbl">注文番号</div>
            <div className="no">{orderNo(done.order_no)}</div>
            <div className="chg">
              <div style={{ fontWeight: 700 }}>おつり</div>
              <div className="v">{yen(done.change_given)}</div>
            </div>
            <div className="meta num">
              <span>合計 {yen(done.total)}</span>
              <span>お預かり {yen(done.received)}</span>
              <span>{hm(done.created_at)}</span>
            </div>
            <div className="hint">番号を口頭でお客様にお伝えください</div>
            <button className="btn primary confirm" autoFocus onClick={() => setDone(null)}>次の会計へ</button>
          </div>
        </div>
      )}
    </div>
  )
}
