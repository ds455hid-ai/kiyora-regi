import { useEffect, useState } from 'react'
import { saveTextFile, toCsv } from '../lib/csv'
import { errorMessage } from '../lib/errors'
import { dateJa, fullJst, hm, orderNo, signedYen, yen } from '../lib/format'
import type { DayRow, SalesSummary } from '../lib/types'
import { useApp } from '../store'

export function Sales() {
  const { snapshot, api, toast, patchOrder } = useApp()
  const day = snapshot!.day
  const orders = snapshot!.orders ?? []
  const [summary, setSummary] = useState<SalesSummary | null>(null)
  const [days, setDays] = useState<DayRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.salesSummary().then((s) => alive && setSummary(s)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, snapshot!.orders, day?.id])

  useEffect(() => {
    let alive = true
    api.salesByDay().then((d) => alive && setDays(d)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, snapshot!.orders, snapshot!.day, snapshot!.balance])

  async function voidOrder(id: string, no: number) {
    const reason = window.prompt(`No.${orderNo(no)} を取り消して全額返金します。\n理由(任意)を入力してください。`, '')
    if (reason === null) return
    setBusy(id)
    try {
      const r = await api.voidOrder(id, reason.trim() || null)
      patchOrder(r.order)
      toast(r.already_voided ? 'すでに取消済みです' : `No.${orderNo(no)} を取り消しました`, r.already_voided ? 'info' : 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function exportSales(dayId: string | null, label: string) {
    setBusy(`csv-${label}`)
    try {
      const rows = await api.exportRows(dayId)
      const csv = toCsv(
        ['営業日', '注文番号', '注文時刻', '会計担当', '状態', '明細行', '商品名', '単価', '数量', '小計', '注文合計', 'お預かり', 'お釣り', '提供完了時刻', '取消理由'],
        rows.map((r) => [
          r.business_date, orderNo(r.order_no), fullJst(r.created_at), r.staff_name, r.status === 'paid' ? '有効' : '取消',
          r.line_no, r.item_name, r.unit_price, r.qty, r.line_total, r.order_total, r.received, r.change_given,
          fullJst(r.served_at), r.void_reason,
        ]),
      )
      await saveTextFile(`yatai-regi_sales_${label}.csv`, csv)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function exportCash(dayId: string, label: string) {
    setBusy(`cash-${label}`)
    try {
      const d = await api.dayDetail(dayId)
      const KIND = { opening: '開始釣銭', sale: '現金売上', refund: '返金', replenish: '補充', collect: '回収' } as const
      const csv = toCsv(
        ['営業日', '時刻', '種別', '金額', '担当', 'メモ'],
        d.cash_events.map((e) => [label, fullJst(e.created_at), KIND[e.kind], e.amount, e.staff_name, e.note]),
      )
      await saveTextFile(`yatai-regi_cash_${label}.csv`, csv)
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function reopen(id: string) {
    if (!window.confirm('この営業日を再開します。レジ締めの記録(過不足)は一度クリアされ、操作履歴には残ります。よろしいですか?')) return
    setBusy(`reopen-${id}`)
    try {
      await api.reopenDay(id)
      toast('営業を再開しました', 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const maxQty = Math.max(1, ...(summary?.by_product ?? []).map((p) => p.qty))
  const latestClosedId = days.find((d) => d.status === 'closed')?.id

  return (
    <div className="screen">
      <div className="stack">
        {!day && <div className="card muted">営業中の日がありません。過去の営業日は下の一覧から確認できます。</div>}

        {day && summary && (
          <>
            <div className="summary-grid">
              <div className="stat hero">
                <div className="lb">本日の総売上({dateJa(day.business_date)})</div>
                <div className="v">{yen(summary.sales_total)}</div>
              </div>
              <div className="stat"><div className="lb">現金売上</div><div className="v">{yen(summary.sales_total)}</div></div>
              <div className="stat"><div className="lb">会計件数</div><div className="v">{summary.order_count}<span style={{ fontSize: '0.9rem' }}> 件</span></div></div>
              <div className="stat"><div className="lb">販売数量</div><div className="v">{summary.item_count}<span style={{ fontSize: '0.9rem' }}> 個</span></div></div>
              <div className="stat"><div className="lb">取消・返金</div><div className="v">{summary.voided_count}<span style={{ fontSize: '0.9rem' }}> 件 / {yen(summary.voided_total)}</span></div></div>
            </div>

            <div className="card">
              <h3>商品別売上・数量</h3>
              {summary.by_product.length === 0 && <div className="muted">まだ売上がありません</div>}
              {summary.by_product.map((p) => (
                <div key={p.name} style={{ padding: '6px 0' }}>
                  <div className="row between"><span style={{ fontWeight: 700 }}>{p.name}</span><span className="num" style={{ fontWeight: 900 }}>{p.qty}個 / {yen(p.amount)}</span></div>
                  <div className="bar"><i style={{ width: `${(p.qty / maxQty) * 100}%` }} /></div>
                </div>
              ))}
            </div>

            <div className="card">
              <h3>スタッフ別 会計</h3>
              <div className="list">
                {summary.by_staff.length === 0 && <div className="muted">まだ会計がありません</div>}
                {summary.by_staff.map((s) => (
                  <div className="li" key={s.staff_name}>
                    <span className="grow" style={{ fontWeight: 700 }}>{s.staff_name}</span>
                    <span className="muted num">{s.order_count}件</span>
                    <span className="num" style={{ fontWeight: 900 }}>{yen(s.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>注文履歴(新しい順)</h3>
              <div className="list">
                {orders.length === 0 && <div className="muted">まだ注文がありません</div>}
                {[...orders].reverse().map((o) => (
                  <div className="li" key={o.id} style={{ alignItems: 'flex-start' }}>
                    <span className="num" style={{ fontWeight: 900, fontSize: '1.2rem', minWidth: 48, color: 'var(--accent-strong)' }}>{orderNo(o.order_no)}</span>
                    <div className="grow">
                      <div style={{ fontSize: '0.88rem' }}>{o.items.map((i) => `${i.name}×${i.qty}`).join('、')}</div>
                      <div className="muted" style={{ fontSize: '0.75rem' }}>{hm(o.created_at)} {o.staff_name}{o.status === 'voided' ? ` / 取消: ${o.void_reason ?? '理由なし'}` : ''}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="num" style={{ fontWeight: 900, textDecoration: o.status === 'voided' ? 'line-through' : 'none' }}>{yen(o.total)}</div>
                      {o.status === 'voided'
                        ? <span className="chip warn">返金済み</span>
                        : <button className="btn sm danger" style={{ marginTop: 4 }} disabled={busy === o.id} onClick={() => void voidOrder(o.id, o.order_no)}>取消・返金</button>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {(
          <div className="card">
            <div className="row between" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>営業日別 売上・現金過不足</h3>
              <button className="btn sm" disabled={busy === 'csv-all'} onClick={() => void exportSales(null, 'all')}>全期間CSV</button>
            </div>
            <div className="list">
              {days.length === 0 && <div className="muted">まだ営業日がありません</div>}
              {days.map((d) => (
                <div key={d.id} className="li" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div className="grow">
                    <div style={{ fontWeight: 900 }}>{dateJa(d.business_date)} {d.status === 'open' ? <span className="chip good">営業中</span> : null}</div>
                    <div className="muted num" style={{ fontSize: '0.8rem' }}>{d.order_count}件 / 取消{d.voided_count}件 / 釣銭 {yen(d.opening_float)}</div>
                    {d.status === 'closed' && (
                      <div style={{ fontSize: '0.8rem' }} className="num">
                        理論 {yen(d.expected_cash ?? 0)} / 実際 {yen(d.counted_cash ?? 0)}{' '}
                        <span className={`chip ${d.variance === 0 ? 'good' : 'warn'}`}>過不足 {signedYen(d.variance ?? 0)}</span>
                        {d.close_note ? <span className="muted"> — {d.close_note}</span> : null}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num" style={{ fontWeight: 900, fontSize: '1.15rem' }}>{yen(d.sales_total)}</div>
                    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4, gap: 6 }}>
                      <button className="btn sm" disabled={busy === `csv-${d.business_date}`} onClick={() => void exportSales(d.id, d.business_date)}>売上CSV</button>
                      <button className="btn sm" disabled={busy === `cash-${d.business_date}`} onClick={() => void exportCash(d.id, d.business_date)}>現金CSV</button>
                      {!day && d.id === latestClosedId && (
                        <button className="btn sm danger" disabled={busy === `reopen-${d.id}`} onClick={() => void reopen(d.id)}>再開</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
