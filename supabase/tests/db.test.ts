import { beforeEach, describe, expect, it } from 'vitest'
import { ADMIN, addProduct, createDb, query, queryError, rpc, rpcError, seedWorld, uuid, type Db } from './harness'

let db: Db
beforeEach(async () => {
  db = await createDb()
}, 60_000)

const order = (r: any) => r.order
const items = (oden: { id: string }, qty = 1) => [{ product_id: oden.id, qty }]

describe('ログインなし(オープン)モード', () => {
  it('未ログイン(anon)のまま、営業開始から会計・提供・返金・レジ締めまで全操作できる', async () => {
    const { alice, admin, oden, day } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 }))
    expect(o.order_no).toBe(1)
    await rpc(db, null, 'serve_order', { p_order: o.id })
    await rpc(db, null, 'set_sold_out', { p_product: oden.id, p_sold_out: true })
    await rpc(db, null, 'set_sold_out', { p_product: oden.id, p_sold_out: false })
    const o2 = order(await rpc(db, null, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    await rpc(db, admin, 'void_order', { p_order: o2.id, p_reason: null })
    const closed = await rpc(db, null, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1, '500': 2 }, p_note: null, p_force: true })
    expect(closed.status).toBe('closed')
    expect((await rpc(db, null, 'sales_by_day'))[0].sales_total).toBe(1000)
  })

  it('スタッフ名はリクエストヘッダー(x-staff-name)から記録される。空・不正・長すぎる場合も安全', async () => {
    const { oden } = await seedWorld(db)
    const mk = async (who: string | null) =>
      order(await rpc(db, who, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    expect((await mk('アリス')).staff_name).toBe('アリス')
    expect((await mk('山田 太郎')).staff_name).toBe('山田 太郎')
    expect((await mk(null)).staff_name).toBe('名無し')
    expect((await mk('   ')).staff_name).toBe('名無し')
    expect((await mk('あ'.repeat(50))).staff_name).toBe('あ'.repeat(30))
    expect((await mk('A\tB\nC')).staff_name).toBe('ABC')
    expect((await mk('<script>')).staff_name).toBe('<script>')
    await db.query(`select set_config('request.headers', '{"x-staff-name":"%E3%82"}', false)`)
    await db.exec('set role anon')
    const r = await db.query<{ n: string }>(`select public._staff_name() as n`)
    await db.exec('reset role')
    expect(r.rows[0].n).toBe('名無し')
  })

  it('端末(anon)からテーブルへ直接書き込めない / 認証テーブルは読めない', async () => {
    const { oden, day } = await seedWorld(db)
    expect(await queryError(db, null, `update products set price = 1 where id = $1`, [oden.id])).toMatch(/permission denied/)
    expect(await queryError(db, null, `insert into cash_events (business_day_id, kind, amount) values ($1, 'replenish', 99999)`, [day.id])).toMatch(/permission denied/)
    expect(await queryError(db, null, `delete from orders`)).toMatch(/permission denied/)
    expect(await queryError(db, null, `update business_days set next_order_no = 1`)).toMatch(/permission denied/)
    expect(await queryError(db, null, `insert into audit_log (action) values ('x')`)).toMatch(/permission denied/)
    expect(await queryError(db, null, `select * from profiles`)).toMatch(/permission denied/)
    expect(await queryError(db, null, `select * from auth.users`)).toMatch(/permission denied/)
  })

  it('読み取りは未ログインでも可能(商品・営業日・注文・現金)', async () => {
    const { alice, oden } = await seedWorld(db)
    await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 })
    expect((await query(db, null, `select * from products`)).length).toBeGreaterThan(0)
    expect(await query(db, null, `select * from orders`)).toHaveLength(1)
    expect((await query(db, null, `select * from cash_events`)).length).toBe(2)
    const snap = await rpc(db, null, 'app_snapshot')
    expect(snap.me).toMatchObject({ display_name: '名無し', role: 'admin', active: true })
    expect(snap.orders).toHaveLength(1)
  })

  it('内部ヘルパーとログイン用のスタッフ管理関数は端末から呼べない', async () => {
    const rows = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`,
    )
    const names = rows.rows.map((r) => r.proname)
    for (const internal of ['_require_staff', '_require_admin', '_audit', '_drawer_balance', '_refresh_order_served',
      '_order_json_by_id', '_lock_day_shared', '_denoms_total', '_urldecode', 'handle_new_user', 'admin_update_staff']) {
      expect(names).not.toContain(internal)
    }
    for (const rpcName of ['create_order', 'serve_order', 'void_order', 'open_business_day', 'close_business_day', 'app_snapshot', 'export_rows']) {
      expect(names).toContain(rpcName)
    }
    const a = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', 'public.admin_update_staff(uuid, boolean, text, text)', 'execute') as ok`)
    expect(a.rows[0].ok).toBe(false)
  })
})

describe('営業日・現金', () => {
  it('営業開始前は会計できない / 営業日は同時に1つだけ', async () => {
    const [oden] = await query(db, null, `select id from products order by sort_order`)
    expect((await rpcError(db, 'アリス', 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))?.message).toBe('no_open_day')
    await rpc(db, ADMIN, 'open_business_day', { p_float: 5000, p_denoms: null, p_date: '2026-10-10' })
    expect((await rpcError(db, ADMIN, 'open_business_day', { p_float: 5000, p_denoms: null, p_date: '2026-10-11' }))?.message).toBe('day_already_open')
  })

  it('釣銭は金種入力から計算され、現金残高に反映される', async () => {
    const day = await rpc(db, ADMIN, 'open_business_day', { p_float: null, p_denoms: { '1000': 5, '500': 10, '100': 20 }, p_date: '2026-10-10' })
    expect(day.opening_float).toBe(5000 + 5000 + 2000)
    const snap = await rpc(db, ADMIN, 'app_snapshot')
    expect(snap.balance).toBe(12000)
    expect(snap.cash_totals).toEqual({ opening: 12000 })
  })

  it('金種に不正な額面や巨大な枚数は拒否される', async () => {
    expect((await rpcError(db, ADMIN, 'open_business_day', { p_float: null, p_denoms: { '777': 1 }, p_date: null }))?.message).toBe('invalid_denoms')
    expect((await rpcError(db, ADMIN, 'open_business_day', { p_float: null, p_denoms: { '1000': -1 }, p_date: null }))?.message).toBe('invalid_denoms')
    expect((await rpcError(db, ADMIN, 'open_business_day', { p_float: null, p_denoms: { '10000': 9999999 }, p_date: null }))?.message).toBe('invalid_denoms')
    expect((await rpcError(db, ADMIN, 'open_business_day', { p_float: -5, p_denoms: null, p_date: null }))?.message).toBe('invalid_amount')
  })

  it('補充・回収: 残高を超える回収は不可 / request_idで二重実行されない', async () => {
    const { admin } = await seedWorld(db, { openFloat: 10000 })
    const req = uuid()
    const r1 = await rpc(db, admin, 'record_cash_event', { p_request_id: req, p_kind: 'replenish', p_amount: 3000, p_note: '釣銭補充' })
    expect(r1).toMatchObject({ duplicate: false, balance: 13000 })
    const r2 = await rpc(db, admin, 'record_cash_event', { p_request_id: req, p_kind: 'replenish', p_amount: 3000, p_note: '釣銭補充' })
    expect(r2).toMatchObject({ duplicate: true, balance: 13000 })
    expect((await rpcError(db, admin, 'record_cash_event', { p_request_id: uuid(), p_kind: 'collect', p_amount: 13001, p_note: null }))?.message).toBe('insufficient_cash')
    const r3 = await rpc(db, admin, 'record_cash_event', { p_request_id: uuid(), p_kind: 'collect', p_amount: 8000, p_note: '売上回収' })
    expect(r3.balance).toBe(5000)
    expect((await rpcError(db, admin, 'record_cash_event', { p_request_id: uuid(), p_kind: 'sale', p_amount: 100, p_note: null }))?.message).toBe('invalid_kind')
    expect((await rpcError(db, admin, 'record_cash_event', { p_request_id: uuid(), p_kind: 'collect', p_amount: 0, p_note: null }))?.message).toBe('invalid_amount')
  })

  it('レジ締め: 未提供があると警告 / 過不足を計算 / 締め後は会計・提供・返金不可', async () => {
    const { admin, alice, oden, day } = await seedWorld(db, { openFloat: 10000 })
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 }))
    const unserved = await rpcError(db, admin, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1 }, p_note: null, p_force: false })
    expect(unserved).toMatchObject({ message: 'unserved_orders', detail: '1' })

    await rpc(db, alice, 'serve_order', { p_order: o.id })
    let closed = await rpc(db, admin, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1, '500': 2 }, p_note: 'ok', p_force: false })
    expect(closed).toMatchObject({ status: 'closed', expected_cash: 11000, counted_cash: 11000, variance: 0 })

    expect((await rpcError(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))?.message).toBe('no_open_day')
    expect((await rpcError(db, admin, 'void_order', { p_order: o.id, p_reason: null }))?.message).toBe('day_closed')
    expect((await rpcError(db, admin, 'close_business_day', { p_day: day.id, p_denoms: {}, p_note: null, p_force: false }))?.message).toBe('day_closed')

    await rpc(db, admin, 'reopen_business_day', { p_day: day.id })
    closed = await rpc(db, admin, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1, '100': 3 }, p_note: '100円玉不足', p_force: false })
    expect(closed).toMatchObject({ expected_cash: 11000, counted_cash: 10300, variance: -700 })
    const byDay = await rpc(db, admin, 'sales_by_day')
    expect(byDay[0]).toMatchObject({ sales_total: 1000, variance: -700, order_count: 1 })
  })

  it('締めた営業日があっても翌日は注文番号が001から始まる', async () => {
    const { admin, alice, oden, day } = await seedWorld(db)
    const o1 = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    expect(o1.order_no).toBe(1)
    await rpc(db, alice, 'serve_order', { p_order: o1.id })
    await rpc(db, admin, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1 }, p_note: null, p_force: false })
    const day2 = await rpc(db, admin, 'open_business_day', { p_float: 8000, p_denoms: null, p_date: '2026-10-11' })
    expect(day2.next_order_no).toBe(1)
    const o2 = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    expect(o2.order_no).toBe(1)
    expect(o2.business_day_id).toBe(day2.id)
    await rpc(db, alice, 'serve_order', { p_order: o2.id })
    await rpc(db, admin, 'close_business_day', { p_day: day2.id, p_denoms: {}, p_note: null, p_force: false })
    expect((await rpcError(db, admin, 'open_business_day', { p_float: 1, p_denoms: null, p_date: '2026-10-11' }))?.message).toBe('day_exists')
  })
})

describe('会計(注文確定・連番・冪等)', () => {
  it('注文番号は連番で、お釣り・合計・現金イベントがDBで計算される', async () => {
    const { alice, bob, oden } = await seedWorld(db)
    const r1 = await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 3), p_received: 2000 })
    const r2 = await rpc(db, bob, 'create_order', { p_request_id: uuid(), p_items: items(oden, 1), p_received: 500 })
    expect(order(r1)).toMatchObject({ order_no: 1, total: 1500, received: 2000, change_given: 500, staff_name: 'アリス', status: 'paid' })
    expect(order(r2)).toMatchObject({ order_no: 2, total: 500, change_given: 0, staff_name: 'ボブ' })
    const snap = await rpc(db, alice, 'app_snapshot')
    expect(snap.balance).toBe(10000 + 1500 + 500)
    expect(snap.orders.map((o: any) => o.order_no)).toEqual([1, 2])
  })

  it('同じrequest_idの再送は二重登録にならず、同じ注文を返す', async () => {
    const { alice, oden } = await seedWorld(db)
    const req = uuid()
    const first = await rpc(db, alice, 'create_order', { p_request_id: req, p_items: items(oden, 2), p_received: 1000 })
    const retry = await rpc(db, alice, 'create_order', { p_request_id: req, p_items: items(oden, 2), p_received: 1000 })
    expect(first.duplicate).toBe(false)
    expect(retry.duplicate).toBe(true)
    expect(order(retry).id).toBe(order(first).id)
    expect(order(retry).order_no).toBe(1)
    const snap = await rpc(db, alice, 'app_snapshot')
    expect(snap.orders).toHaveLength(1)
    expect(snap.balance).toBe(10000 + 1000)
    const next = await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 })
    expect(order(next).order_no).toBe(2)
  })

  it('単価は端末の値ではなくサーバーの商品マスタから取り、過去注文の価格は保持される', async () => {
    const { admin, alice, oden } = await seedWorld(db)
    const o1 = order(await rpc(db, alice, 'create_order', {
      p_request_id: uuid(), p_items: [{ product_id: oden.id, qty: 1, price: 1, unit_price: 1 }], p_received: 500,
    }))
    expect(o1.total).toBe(500)
    expect(o1.items[0]).toMatchObject({ unit_price: 500, name: 'おでん(5個入り)', qty: 1 })

    await rpc(db, admin, 'upsert_product', { p_id: oden.id, p_name: 'おでん5個', p_price: 600, p_category: 'food', p_sort_order: 10, p_visible: true })
    const o2 = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 1000 }))
    expect(o2).toMatchObject({ total: 600, change_given: 400 })
    const snap = await rpc(db, alice, 'app_snapshot')
    const old = snap.orders.find((o: any) => o.order_no === 1)
    expect(old.total).toBe(500)
    expect(old.items[0]).toMatchObject({ unit_price: 500, name: 'おでん(5個入り)' })
    await rpc(db, admin, 'delete_product', { p_id: oden.id })
    const snap2 = await rpc(db, alice, 'app_snapshot')
    expect(snap2.orders).toHaveLength(2)
    expect(snap2.orders[0].items[0].name).toBe('おでん(5個入り)')
  })

  it('同一商品の複数行は合算され、複数商品の合計が正しい', async () => {
    const { admin, alice, oden } = await seedWorld(db)
    const cola = await addProduct(db, admin, 'コーラ', 200)
    const r = order(await rpc(db, alice, 'create_order', {
      p_request_id: uuid(), p_received: 2000,
      p_items: [{ product_id: oden.id, qty: 1 }, { product_id: cola.id, qty: 2 }, { product_id: oden.id, qty: 1 }],
    }))
    expect(r.total).toBe(500 * 2 + 200 * 2)
    expect(r.items).toHaveLength(2)
    expect(r.items.find((i: any) => i.name === 'おでん(5個入り)').qty).toBe(2)
  })

  it('初期商品(おでん・飲み物・ぜんざい)が登録されている', async () => {
    const rows = await query<{ name: string; price: number }>(db, null, `select name, price from products order by sort_order`)
    expect(rows).toEqual([
      { name: 'おでん(5個入り)', price: 500 },
      { name: 'コーヒー', price: 300 },
      { name: 'カフェラテ', price: 300 },
      { name: '紅茶', price: 300 },
      { name: 'ゆず蜂蜜', price: 300 },
      { name: 'ココア', price: 300 },
      { name: 'ぜんざい', price: 400 },
    ])
  })

  it('不正な会計は拒否される(不足・数量・存在しない/非表示/売り切れ商品)', async () => {
    const { admin, alice, oden } = await seedWorld(db)
    const cola = await addProduct(db, admin, 'コーラ', 200)
    const e = async (items: any, received: number) => (await rpcError(db, alice, 'create_order', { p_request_id: uuid(), p_items: items, p_received: received }))
    expect((await e(items(oden, 2), 999))?.message).toBe('insufficient_received')
    expect((await e(items(oden, 0), 1000))?.message).toBe('invalid_qty')
    expect((await e(items(oden, 100), 99999999))?.message).toBe('invalid_qty')
    expect((await e([], 1000))?.message).toBe('invalid_items')
    expect((await e([{ product_id: uuid(), qty: 1 }], 1000))?.message).toBe('product_not_found')
    expect((await e(items(oden), 100000001))?.message).toBe('invalid_received')

    await rpc(db, alice, 'set_sold_out', { p_product: cola.id, p_sold_out: true })
    expect(await e(items(cola), 200)).toMatchObject({ message: 'product_sold_out', detail: 'コーラ' })
    await rpc(db, alice, 'set_sold_out', { p_product: cola.id, p_sold_out: false })
    expect(await e(items(cola), 200)).toBeNull()

    await rpc(db, admin, 'upsert_product', { p_id: cola.id, p_name: 'コーラ', p_price: 200, p_category: 'drink', p_sort_order: 200, p_visible: false })
    expect((await e(items(cola), 200))?.message).toBe('product_hidden')
    const ok = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    expect(ok.order_no).toBe(2)
  })

  it('スタッフ名は端末の申告(ヘッダー)から記録され、staff_id は持たない', async () => {
    const { alice, oden } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    expect(o.staff_name).toBe('アリス')
    expect(o.staff_id).toBeNull()
  })
})

describe('受け渡し(二重提供の防止)', () => {
  it('serve_order は二重に実行しても1回分しか記録されない', async () => {
    const { alice, bob, oden } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 }))
    const a = await rpc(db, alice, 'serve_order', { p_order: o.id })
    const b = await rpc(db, bob, 'serve_order', { p_order: o.id })
    expect(a).toMatchObject({ ok: true, already_served: false })
    expect(b).toMatchObject({ ok: true, already_served: true, served_by: 'アリス' })
    expect(a.order.served_at).not.toBeNull()
    const snap = await rpc(db, bob, 'app_snapshot')
    expect(snap.serve_events).toHaveLength(1)
    expect(snap.serve_events[0]).toMatchObject({ delta: 2, staff_name: 'アリス' })
    expect(snap.orders[0].items[0].served_qty).toBe(2)
  })

  it('serve_item は比較更新: 他のスタッフが先に更新していたら conflict を返す', async () => {
    const { alice, bob, oden } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 3), p_received: 2000 }))
    const itemId = o.items[0].id
    expect(await rpc(db, alice, 'serve_item', { p_item: itemId, p_from: 0, p_to: 1 })).toMatchObject({ ok: true, changed: true })
    const dup = await rpc(db, bob, 'serve_item', { p_item: itemId, p_from: 0, p_to: 1 })
    expect(dup).toMatchObject({ ok: false, reason: 'conflict', served_qty: 1, served_by: 'アリス' })
    expect(dup.order.items[0].served_qty).toBe(1)
    await rpc(db, bob, 'serve_item', { p_item: itemId, p_from: 1, p_to: 3 })
    const done = await rpc(db, bob, 'serve_item', { p_item: itemId, p_from: 3, p_to: 3 })
    expect(done.order.served_at).not.toBeNull()
    expect((await rpcError(db, bob, 'serve_item', { p_item: itemId, p_from: 3, p_to: 4 }))?.message).toBe('invalid_qty')
    const snap = await rpc(db, bob, 'app_snapshot')
    expect(snap.serve_events.reduce((s: number, e: any) => s + e.delta, 0)).toBe(3)
  })

  it('提供の取り消しで未提供に戻せる / 返金済みの注文は提供できない', async () => {
    const { admin, alice, oden } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 }))
    await rpc(db, alice, 'serve_order', { p_order: o.id })
    const back = await rpc(db, alice, 'unserve_order', { p_order: o.id })
    expect(back.order.served_at).toBeNull()
    expect(back.order.items[0].served_qty).toBe(0)
    await rpc(db, admin, 'void_order', { p_order: o.id, p_reason: '注文間違い' })
    expect((await rpcError(db, alice, 'serve_order', { p_order: o.id }))?.message).toBe('order_voided')
    expect((await rpcError(db, alice, 'serve_item', { p_item: o.items[0].id, p_from: 0, p_to: 1 }))?.message).toBe('order_voided')
  })
})

describe('返金・売上', () => {
  it('会計取消で現金残高が戻り、二重取消しでも二重返金されない', async () => {
    const { admin, alice, oden } = await seedWorld(db, { openFloat: 10000 })
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 }))
    expect((await rpc(db, admin, 'app_snapshot')).balance).toBe(11000)
    const v1 = await rpc(db, admin, 'void_order', { p_order: o.id, p_reason: '返品' })
    const v2 = await rpc(db, admin, 'void_order', { p_order: o.id, p_reason: '返品' })
    expect(v1.already_voided).toBe(false)
    expect(v2.already_voided).toBe(true)
    const snap = await rpc(db, admin, 'app_snapshot')
    expect(snap.balance).toBe(10000)
    expect(snap.cash_totals).toEqual({ opening: 10000, sale: 1000, refund: -1000 })
    expect(snap.orders[0]).toMatchObject({ status: 'voided', void_reason: '返品', voided_by_name: '店長' })
    const sum = await rpc(db, admin, 'sales_summary', { p_day: null })
    expect(sum).toMatchObject({ sales_total: 0, order_count: 0, voided_count: 1, voided_total: 1000 })
  })

  it('現金を回収済みで返金に足りない場合は返金できない', async () => {
    const { admin, alice, oden } = await seedWorld(db, { openFloat: 0 })
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 }))
    await rpc(db, admin, 'record_cash_event', { p_request_id: uuid(), p_kind: 'collect', p_amount: 1000, p_note: null })
    expect(await rpcError(db, admin, 'void_order', { p_order: o.id, p_reason: null })).toMatchObject({ message: 'insufficient_cash', detail: '1000' })
  })

  it('売上集計: 商品別・スタッフ別・合計', async () => {
    const { admin, alice, bob, oden } = await seedWorld(db)
    const cola = await addProduct(db, admin, 'コーラ', 200)
    await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: [{ product_id: oden.id, qty: 2 }, { product_id: cola.id, qty: 1 }], p_received: 1200 })
    await rpc(db, bob, 'create_order', { p_request_id: uuid(), p_items: [{ product_id: cola.id, qty: 3 }], p_received: 1000 })
    const s = await rpc(db, bob, 'sales_summary', { p_day: null })
    expect(s).toMatchObject({ sales_total: 1200 + 600, order_count: 2, item_count: 6 })
    expect(s.by_product).toEqual([
      { name: 'コーラ', qty: 4, amount: 800 },
      { name: 'おでん(5個入り)', qty: 2, amount: 1000 },
    ])
    expect(s.by_staff).toEqual([
      { staff_name: 'アリス', order_count: 1, amount: 1200 },
      { staff_name: 'ボブ', order_count: 1, amount: 600 },
    ])
  })

  it('CSV出力用の行', async () => {
    const { admin, alice, oden, day } = await seedWorld(db)
    await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 })
    const rows = await rpc(db, admin, 'export_rows', { p_day: day.id })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ business_date: '2026-10-10', order_no: 1, item_name: 'おでん(5個入り)', qty: 2, line_total: 1000, order_total: 1000, staff_name: 'アリス' })
  })
})

describe('履歴・配信設定', () => {
  it('操作履歴(監査ログ)に主要操作が担当者名つきで残る', async () => {
    const { admin, alice, oden } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    await rpc(db, admin, 'void_order', { p_order: o.id, p_reason: 'テスト' })
    const log = await rpc(db, admin, 'list_audit', { p_limit: 100 })
    const actions = log.map((l: any) => l.action)
    expect(actions).toEqual(expect.arrayContaining(['open_day', 'create_order', 'void_order']))
    expect(log.find((l: any) => l.action === 'create_order')).toMatchObject({ staff_name: 'アリス' })
    expect(log.find((l: any) => l.action === 'void_order')).toMatchObject({ staff_name: '店長' })
  })

  it('Realtime の配信対象テーブルが登録されている', async () => {
    const r = await db.query<{ tablename: string }>(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)
    expect(r.rows.map((x) => x.tablename)).toEqual(['business_days', 'cash_events', 'order_items', 'orders', 'products', 'profiles', 'serve_events'])
  })
})

describe('整合性の不変条件', () => {
  it('多数の会計・返金・補充・回収のあとでも 残高 = 開始 + 売上 - 返金 + 補充 - 回収、注文番号は連続で重複なし', async () => {
    const { admin, alice, bob, oden } = await seedWorld(db, { openFloat: 20000 })
    const staff = [alice, bob]
    const orders: any[] = []
    for (let i = 0; i < 30; i++) {
      const qty = (i % 4) + 1
      const total = qty * 500
      const r = await rpc(db, staff[i % 2], 'create_order', { p_request_id: uuid(), p_items: items(oden, qty), p_received: total + (i % 3) * 500 })
      orders.push(order(r))
    }
    await rpc(db, admin, 'void_order', { p_order: orders[3].id, p_reason: null })
    await rpc(db, admin, 'void_order', { p_order: orders[10].id, p_reason: null })
    await rpc(db, admin, 'record_cash_event', { p_request_id: uuid(), p_kind: 'collect', p_amount: 15000, p_note: null })
    await rpc(db, admin, 'record_cash_event', { p_request_id: uuid(), p_kind: 'replenish', p_amount: 2500, p_note: null })

    const snap = await rpc(db, admin, 'app_snapshot')
    const nos = snap.orders.map((o: any) => o.order_no)
    expect(nos).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    const paid = snap.orders.filter((o: any) => o.status === 'paid').reduce((s: number, o: any) => s + o.total, 0)
    expect(snap.balance).toBe(20000 + paid - 15000 + 2500)
    const all = await query<{ s: number }>(db, admin, `select sum(amount)::int s from cash_events`)
    expect(all[0].s).toBe(snap.balance)
    for (const o of snap.orders) expect(o.change_given).toBe(o.received - o.total)
  })
})
