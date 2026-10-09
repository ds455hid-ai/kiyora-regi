import { beforeEach, describe, expect, it } from 'vitest'
import { addProduct, createDb, query, queryError, rpc, rpcError, seedWorld, signUp, uuid, type Db } from './harness'

let db: Db
beforeEach(async () => {
  db = await createDb()
}, 60_000)

const order = (r: any) => r.order
const items = (oden: { id: string }, qty = 1) => [{ product_id: oden.id, qty }]

describe('認証・承認・権限', () => {
  it('最初の登録者だけが管理者(承認済み)になり、以降は承認待ちになる', async () => {
    const a = await signUp(db, '店長')
    const b = await signUp(db, 'スタッフ')
    const rows = await query(db, a, `select id, role, active from profiles order by created_at`)
    expect(rows.find((r) => r.id === a)).toMatchObject({ role: 'admin', active: true })
    expect(rows.find((r) => r.id === b)).toMatchObject({ role: 'staff', active: false })
  })

  it('承認待ちユーザーは何も読めず、業務RPCも呼べない', async () => {
    const admin = await signUp(db, '店長')
    const pending = await signUp(db, '新人')
    expect(await query(db, pending, `select * from products`)).toHaveLength(0)
    const snap = await rpc(db, pending, 'app_snapshot')
    expect(snap.me).toMatchObject({ active: false })
    expect(snap.products).toBeUndefined()
    expect((await rpcError(db, pending, 'create_order', { p_request_id: uuid(), p_items: [], p_received: 0 }))?.message).toBe('forbidden')
    expect((await rpcError(db, pending, 'serve_order', { p_order: uuid() }))?.message).toBe('forbidden')
    // 承認すると見える
    await rpc(db, admin, 'admin_update_staff', { p_user: pending, p_active: true, p_role: 'staff' })
    expect((await query(db, pending, `select * from products`)).length).toBeGreaterThan(0)
  })

  it('未ログイン(anon)はテーブルもRPCも使えない', async () => {
    expect(await queryError(db, null, `select * from products`)).toMatch(/permission denied/)
    expect(await queryError(db, null, `select * from orders`)).toMatch(/permission denied/)
    expect((await rpcError(db, null, 'app_snapshot'))?.message).toMatch(/permission denied/)
    expect((await rpcError(db, null, 'create_order', { p_request_id: uuid(), p_items: [], p_received: 0 }))?.message).toMatch(/permission denied/)
  })

  it('一般スタッフは管理系RPCを呼べない', async () => {
    const { alice, oden, day } = await seedWorld(db)
    const denied = async (fn: string, args: any) => expect((await rpcError(db, alice, fn, args))?.message).toBe('forbidden')
    await denied('open_business_day', { p_float: 1, p_denoms: null, p_date: null })
    await denied('close_business_day', { p_day: day.id, p_denoms: {}, p_note: null, p_force: true })
    await denied('upsert_product', { p_id: oden.id, p_name: 'x', p_price: 1, p_category: 'food', p_sort_order: 0, p_visible: true })
    await denied('delete_product', { p_id: oden.id })
    await denied('admin_update_staff', { p_user: alice, p_active: true, p_role: 'admin' })
    await denied('record_cash_event', { p_request_id: uuid(), p_kind: 'replenish', p_amount: 100, p_note: null })
    await denied('void_order', { p_order: uuid(), p_reason: null })
    await denied('sales_by_day', {})
    await denied('export_rows', { p_day: null })
    await denied('list_audit', { p_limit: 10 })
    await denied('day_detail', { p_day: day.id })
  })

  it('端末(管理者も含む)から注文・現金・商品テーブルへ直接書き込めない', async () => {
    const { admin, alice, oden, day } = await seedWorld(db)
    for (const uid of [alice, admin]) {
      expect(await queryError(db, uid, `update products set price = 1 where id = $1`, [oden.id])).toMatch(/permission denied/)
      expect(await queryError(db, uid, `insert into cash_events (business_day_id, kind, amount) values ($1, 'replenish', 99999)`, [day.id])).toMatch(/permission denied/)
      expect(await queryError(db, uid, `delete from orders`)).toMatch(/permission denied/)
      expect(await queryError(db, uid, `update profiles set role = 'admin' where id = $1`, [alice])).toMatch(/permission denied/)
      expect(await queryError(db, uid, `update business_days set next_order_no = 1`)).toMatch(/permission denied/)
    }
  })

  it('最後の管理者は降格・無効化できない', async () => {
    const { admin, alice } = await seedWorld(db)
    expect((await rpcError(db, admin, 'admin_update_staff', { p_user: admin, p_active: true, p_role: 'staff' }))?.message).toBe('last_admin')
    expect((await rpcError(db, admin, 'admin_update_staff', { p_user: admin, p_active: false, p_role: 'admin' }))?.message).toBe('last_admin')
    // 管理者を増やせば降格できる
    await rpc(db, admin, 'admin_update_staff', { p_user: alice, p_active: true, p_role: 'admin' })
    await rpc(db, admin, 'admin_update_staff', { p_user: admin, p_active: true, p_role: 'staff' })
  })

  it('全関数がanonに公開されていない', async () => {
    const rows = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`,
    )
    expect(rows.rows.map((r) => r.proname)).toEqual([])
  })

  it('端末から呼べる関数は意図したものだけ(内部ヘルパーは不可)', async () => {
    const rows = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`,
    )
    const names = rows.rows.map((r) => r.proname)
    for (const internal of ['_require_staff', '_require_admin', '_audit', '_drawer_balance', '_refresh_order_served', '_order_json_by_id', 'handle_new_user', '_denoms_total']) {
      expect(names).not.toContain(internal)
    }
    expect(names).toContain('create_order')
  })
})

describe('営業日・現金', () => {
  it('営業開始前は会計できない / 営業日は同時に1つだけ', async () => {
    const admin = await signUp(db, '店長')
    const alice = await signUp(db, 'アリス')
    await rpc(db, admin, 'admin_update_staff', { p_user: alice, p_active: true, p_role: 'staff' })
    const [oden] = await query(db, admin, `select id from products order by sort_order`)
    expect((await rpcError(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))?.message).toBe('no_open_day')
    await rpc(db, admin, 'open_business_day', { p_float: 5000, p_denoms: null, p_date: '2026-10-10' })
    expect((await rpcError(db, admin, 'open_business_day', { p_float: 5000, p_denoms: null, p_date: '2026-10-11' }))?.message).toBe('day_already_open')
  })

  it('釣銭は金種入力から計算され、現金残高に反映される', async () => {
    const admin = await signUp(db, '店長')
    const day = await rpc(db, admin, 'open_business_day', { p_float: null, p_denoms: { '1000': 5, '500': 10, '100': 20 }, p_date: '2026-10-10' })
    expect(day.opening_float).toBe(5000 + 5000 + 2000)
    const snap = await rpc(db, admin, 'app_snapshot')
    expect(snap.balance).toBe(12000)
    expect(snap.cash_totals).toEqual({ opening: 12000 })
  })

  it('金種に不正な額面や巨大な枚数は拒否される', async () => {
    const admin = await signUp(db, '店長')
    expect((await rpcError(db, admin, 'open_business_day', { p_float: null, p_denoms: { '777': 1 }, p_date: null }))?.message).toBe('invalid_denoms')
    expect((await rpcError(db, admin, 'open_business_day', { p_float: null, p_denoms: { '1000': -1 }, p_date: null }))?.message).toBe('invalid_denoms')
    expect((await rpcError(db, admin, 'open_business_day', { p_float: null, p_denoms: { '10000': 9999999 }, p_date: null }))?.message).toBe('invalid_denoms')
    expect((await rpcError(db, admin, 'open_business_day', { p_float: -5, p_denoms: null, p_date: null }))?.message).toBe('invalid_amount')
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
    // 理論残高 = 10000 + 1000 = 11000。実際は 10000×1 + 500×2 = 11000 → 過不足 0
    let closed = await rpc(db, admin, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1, '500': 2 }, p_note: 'ok', p_force: false })
    expect(closed).toMatchObject({ status: 'closed', expected_cash: 11000, counted_cash: 11000, variance: 0 })

    expect((await rpcError(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))?.message).toBe('no_open_day')
    expect((await rpcError(db, admin, 'void_order', { p_order: o.id, p_reason: null }))?.message).toBe('day_closed')
    expect((await rpcError(db, admin, 'close_business_day', { p_day: day.id, p_denoms: {}, p_note: null, p_force: false }))?.message).toBe('day_closed')

    // 再開 → 再度締めて不足を記録
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
    // 同じ日付は二重に開けない
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
    // 次の新規会計は 002(欠番・重複なし)
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

    // 値上げ・改名しても過去の注文は変わらない
    await rpc(db, admin, 'upsert_product', { p_id: oden.id, p_name: 'おでん5個', p_price: 600, p_category: 'food', p_sort_order: 10, p_visible: true })
    const o2 = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 1000 }))
    expect(o2).toMatchObject({ total: 600, change_given: 400 })
    const snap = await rpc(db, alice, 'app_snapshot')
    const old = snap.orders.find((o: any) => o.order_no === 1)
    expect(old.total).toBe(500)
    expect(old.items[0]).toMatchObject({ unit_price: 500, name: 'おでん(5個入り)' })
    // 商品を削除しても注文は残る
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

    await rpc(db, admin, 'upsert_product', { p_id: cola.id, p_name: 'コーラ', p_price: 200, p_category: 'drink', p_sort_order: 20, p_visible: false })
    expect((await e(items(cola), 200))?.message).toBe('product_hidden')
    // 失敗した会計で注文番号が消費されない
    const ok = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    expect(ok.order_no).toBe(2) // 上で唯一成功したコーラ会計が 1
  })

  it('スタッフ名は端末の申告ではなく認証ユーザーから記録される', async () => {
    const { alice, oden } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    expect(o.staff_name).toBe('アリス')
    expect(o.staff_id).toBe(alice)
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
    // ボブも「0 → 1」を押した(画面が古い) → 二重カウントされず conflict
    const dup = await rpc(db, bob, 'serve_item', { p_item: itemId, p_from: 0, p_to: 1 })
    expect(dup).toMatchObject({ ok: false, reason: 'conflict', served_qty: 1, served_by: 'アリス' })
    expect(dup.order.items[0].served_qty).toBe(1)
    // 最新値からなら進められ、全量で served_at が立つ
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
    // 売上は取消し分を除外
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

  it('CSV出力用の行(管理者のみ)', async () => {
    const { admin, alice, oden, day } = await seedWorld(db)
    await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden, 2), p_received: 1000 })
    const rows = await rpc(db, admin, 'export_rows', { p_day: day.id })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ business_date: '2026-10-10', order_no: 1, item_name: 'おでん(5個入り)', qty: 2, line_total: 1000, order_total: 1000, staff_name: 'アリス' })
  })
})

describe('RLS: 閲覧範囲', () => {
  it('一般スタッフは営業中の日のデータだけ見え、過去日は管理者のみ', async () => {
    const { admin, alice, oden, day } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    await rpc(db, alice, 'serve_order', { p_order: o.id })
    await rpc(db, admin, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1, '500': 1 }, p_note: null, p_force: false })
    await rpc(db, admin, 'open_business_day', { p_float: 1000, p_denoms: null, p_date: '2026-10-11' })

    expect(await query(db, alice, `select id from orders`)).toHaveLength(0)
    expect(await query(db, alice, `select id from business_days`)).toHaveLength(1)
    expect(await query(db, alice, `select id from cash_events where business_day_id = $1`, [day.id])).toHaveLength(0)
    expect(await query(db, admin, `select id from orders`)).toHaveLength(1)
    expect(await query(db, admin, `select id from business_days`)).toHaveLength(2)
    const detail = await rpc(db, admin, 'day_detail', { p_day: day.id })
    expect(detail.orders).toHaveLength(1)
    // 監査ログは管理者のみ
    expect((await query(db, alice, `select * from audit_log`))).toHaveLength(0)
    expect((await query(db, admin, `select * from audit_log`)).length).toBeGreaterThan(5)
  })

  it('操作履歴(監査ログ)に主要操作が残る', async () => {
    const { admin, alice, oden } = await seedWorld(db)
    const o = order(await rpc(db, alice, 'create_order', { p_request_id: uuid(), p_items: items(oden), p_received: 500 }))
    await rpc(db, admin, 'void_order', { p_order: o.id, p_reason: 'テスト' })
    const log = await rpc(db, admin, 'list_audit', { p_limit: 100 })
    const actions = log.map((l: any) => l.action)
    expect(actions).toEqual(expect.arrayContaining(['open_day', 'staff_update', 'create_order', 'void_order']))
    expect(log.find((l: any) => l.action === 'create_order')).toMatchObject({ staff_name: 'アリス' })
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
    // お釣り = 預かり - 合計 が全注文で成立
    for (const o of snap.orders) expect(o.change_given).toBe(o.received - o.total)
  })
})
