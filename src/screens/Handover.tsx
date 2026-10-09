import { useMemo, useState } from 'react'
import { errorMessage } from '../lib/errors'
import { dateTimeJa, hm, orderNo } from '../lib/format'
import type { Order, OrderItem } from '../lib/types'
import { useApp } from '../store'

type Filter = 'pending' | 'served' | 'all'

export function Handover() {
  const { snapshot, api, toast, patchOrder, staffName } = useApp()
  const orders = snapshot!.orders ?? []
  const [view, setView] = useState<'orders' | 'history'>('orders')
  const [filter, setFilter] = useState<Filter>('pending')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders])
  const pendingOrders = orders.filter((o) => o.status === 'paid' && !o.served_at)

  const pendingByProduct = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of pendingOrders) for (const i of o.items) m.set(i.name, (m.get(i.name) ?? 0) + (i.qty - i.served_qty))
    return [...m.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  }, [pendingOrders])

  const visible = useMemo(() => {
    const digits = q.replace(/[^0-9]/g, '')
    let list = orders.filter((o) => {
      if (filter === 'pending') return o.status === 'paid' && !o.served_at
      if (filter === 'served') return o.status === 'paid' && !!o.served_at
      return true
    })
    if (digits) list = list.filter((o) => orderNo(o.order_no).includes(digits))
    return filter === 'pending'
      ? list.sort((a, b) => a.order_no - b.order_no)
      : list.sort((a, b) => b.order_no - a.order_no)
  }, [orders, filter, q])

  async function serveAll(o: Order) {
    setBusy(o.id)
    try {
      const r = await api.serveOrder(o.id)
      patchOrder(r.order)
      if (r.already_served) toast(`No.${orderNo(o.order_no)} はすでに${r.served_by ?? '他のスタッフ'}さんが提供済みです`, 'info')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function step(item: OrderItem, delta: number) {
    setBusy(item.id)
    try {
      const r = await api.serveItem(item.id, item.served_qty, item.served_qty + delta)
      patchOrder(r.order)
      if (!r.ok) toast(`${r.served_by ?? '他のスタッフ'}さんが先に更新していたため、最新の状態に更新しました`, 'info')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function undo(o: Order) {
    if (!window.confirm(`No.${orderNo(o.order_no)} の提供を取り消して「未提供」に戻しますか?`)) return
    setBusy(o.id)
    try {
      const r = await api.unserveOrder(o.id)
      patchOrder(r.order)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  if (!snapshot!.day) {
    return <div className="screen"><div className="card">営業が開始されていません。</div></div>
  }

  return (
    <div className="screen">
      <div className="stack">
        <div className="seg" role="group" aria-label="表示切替">
          <button aria-pressed={view === 'orders'} onClick={() => setView('orders')}>注文</button>
          <button aria-pressed={view === 'history'} onClick={() => setView('history')}>提供履歴</button>
        </div>

        {view === 'orders' ? (
          <>
            <div className="card" style={{ padding: 10 }}>
              <div className="row between">
                <span style={{ fontWeight: 900 }}>未提供 <span className="num" style={{ fontSize: '1.4rem', color: 'var(--accent-strong)' }}>{pendingOrders.length}</span> 件</span>
                <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 6 }}>
                  {pendingByProduct.map(([name, n]) => (
                    <span key={name} className="chip accent num">{name} ×{n}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="row">
              <div className="seg grow" role="group" aria-label="絞り込み">
                <button aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>未提供</button>
                <button aria-pressed={filter === 'served'} onClick={() => setFilter('served')}>提供済み</button>
                <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>すべて</button>
              </div>
              <input
                className="input num"
                style={{ width: 120 }}
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="番号検索"
                aria-label="注文番号で検索"
                value={q}
                onChange={(e) => setQ(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              />
            </div>

            <div className="ocards">
              {visible.map((o) => {
                const voided = o.status === 'voided'
                const served = !voided && !!o.served_at
                return (
                  <div key={o.id} className={`ocard ${voided ? 'voided' : served ? 'served' : 'pending'}`}>
                    <div className="head">
                      <span className="ono">{orderNo(o.order_no)}</span>
                      <div className="grow">
                        <div className="num" style={{ fontWeight: 700 }}>{hm(o.created_at)}</div>
                        <div className="muted" style={{ fontSize: '0.78rem' }}>会計: {o.staff_name}</div>
                      </div>
                      {voided && <span className="chip warn">返金済み</span>}
                      {served && <span className="chip good">提供済み</span>}
                    </div>
                    {o.items.map((it) => (
                      <div className="oitem" key={it.id}>
                        <div>
                          <div className="nm">{it.name} ×{it.qty}</div>
                          {it.last_served_by_name && it.served_qty > 0 && (
                            <div className="muted" style={{ fontSize: '0.72rem' }}>{it.last_served_by_name}さんが提供</div>
                          )}
                        </div>
                        {voided ? (
                          <span className="muted">—</span>
                        ) : (
                          <div className="stepper">
                            <button aria-label={`${it.name}の提供を1つ戻す`} disabled={busy === it.id || it.served_qty <= 0} onClick={() => void step(it, -1)}>−</button>
                            <span className={`prog${it.served_qty >= it.qty ? ' done' : ''}`}>
                              <span className="n">{it.served_qty}/{it.qty}</span>
                            </span>
                            <button aria-label={`${it.name}を1つ提供`} disabled={busy === it.id || it.served_qty >= it.qty} onClick={() => void step(it, 1)}>＋</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {voided && <div className="hint">取消: {o.voided_by_name}({o.void_reason ?? '理由なし'})</div>}
                    {!voided && !served && (
                      <button className="btn good serve" disabled={busy === o.id} onClick={() => void serveAll(o)}>
                        {busy === o.id ? '処理中…' : '提供完了'}
                      </button>
                    )}
                    {served && (
                      <div className="row between">
                        <span className="hint">{o.served_at ? hm(o.served_at) : ''} 完了</span>
                        <button className="btn sm" disabled={busy === o.id} onClick={() => void undo(o)}>提供を取り消す</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {visible.length === 0 && (
              <div className="card muted" style={{ textAlign: 'center' }}>
                {q ? `番号「${q}」の注文はありません` : filter === 'pending' ? '未提供の注文はありません' : '該当する注文はありません'}
              </div>
            )}
          </>
        ) : (
          <div className="card list">
            {(snapshot!.serve_events ?? []).length === 0 && <div className="muted" style={{ textAlign: 'center', padding: 12 }}>提供履歴はまだありません</div>}
            {(snapshot!.serve_events ?? []).map((e) => {
              const o = orderById.get(e.order_id)
              return (
                <div className="li" key={e.id}>
                  <span className="num" style={{ fontWeight: 900, minWidth: 44 }}>{o ? orderNo(o.order_no) : '---'}</span>
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{e.item_name} ×{Math.abs(e.delta)}</div>
                    <div className="muted" style={{ fontSize: '0.75rem' }}>{e.staff_name}</div>
                  </div>
                  <span className={`chip ${e.delta > 0 ? 'good' : 'warn'}`}>{e.delta > 0 ? '提供' : '取消'}</span>
                  <span className="num muted" style={{ fontSize: '0.8rem' }}>{dateTimeJa(e.created_at)}</span>
                </div>
              )
            })}
          </div>
        )}
        <div className="hint" style={{ textAlign: 'center' }}>担当: {staffName} / すべての端末の注文がリアルタイムで表示されます</div>
      </div>
    </div>
  )
}
