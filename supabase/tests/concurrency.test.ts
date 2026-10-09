// 本物の PostgreSQL(embedded-postgres)に複数の接続から同時に RPC を投げ、
// 注文番号の重複・二重会計・二重提供・二重返金・デッドロックが起きないことを確認する。
// (PGlite は単一接続なので、同時実行の検証はこのテストで行う)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATION, SUPABASE_STUB_SQL } from './harness'

const PORT = 54329
let server: EmbeddedPostgres
let dir: string
let pool: pg.Pool

/** PostgREST と同じ: RPC 1 回 = 1 トランザクション(set local role anon + x-staff-name ヘッダー) */
async function call<T = any>(who: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('set local role anon')
    await client.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-staff-name': encodeURIComponent(who) })])
    const keys = Object.keys(args)
    const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
    const values = keys.map((k) => {
      const v = args[k]
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
    })
    const res = await client.query(`select public.${fn}(${params}) as r`, values)
    await client.query('commit')
    return res.rows[0].r as T
  } catch (e) {
    await client.query('rollback').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

const settle = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps)
const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null)

async function admin<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[]
}

async function newWorld(openFloat = 20000) {
  await admin('truncate public.audit_log, public.serve_events, public.cash_events, public.order_items, public.orders, public.business_days restart identity cascade')
  const boss = '店長'
  const staff = ['A', 'B', 'C', 'D']
  await call(boss, 'open_business_day', { p_float: openFloat, p_denoms: null, p_date: '2026-10-10' })
  const [oden] = await admin<{ id: string }>(`select id from public.products order by sort_order limit 1`)
  return { boss, staff, oden }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kiyora-pg-'))
  // 本番(Supabase)と同じ UTF8 で作る(日本語のスタッフ名・商品名を扱うため)
  server = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'password', port: PORT, persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  })
  await server.initialise()
  await server.start()
  await server.createDatabase('pos')
  pool = new pg.Pool({ host: 'localhost', port: PORT, user: 'postgres', password: 'password', database: 'pos', max: 16 })
  await pool.query(SUPABASE_STUB_SQL)
  await pool.query(MIGRATION)
}, 180_000)

afterAll(async () => {
  await pool?.end()
  await server?.stop()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

describe('同時アクセス(本物の PostgreSQL)', () => {
  it('4 人が同時に 60 件会計しても注文番号は 1..60 で重複・欠番なし、現金残高も一致', async () => {
    const { staff, oden } = await newWorld(20000)
    const jobs = Array.from({ length: 60 }, (_, i) =>
      call(staff[i % 4], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: oden.id, qty: (i % 3) + 1 }], p_received: 5000 }),
    )
    const results = await settle(jobs)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0)

    const nos = (await admin<{ order_no: number }>(`select order_no from orders order by order_no`)).map((r) => r.order_no)
    expect(nos).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    const [{ s }] = await admin<{ s: number }>(`select coalesce(sum(total),0)::int s from orders`)
    const [{ b }] = await admin<{ b: number }>(`select sum(amount)::int b from cash_events`)
    expect(b).toBe(20000 + s)
    // 各スタッフに全員ぶん割り当てられている(同時実行でも直列化されている)
    const per = await admin<{ staff_name: string; n: number }>(`select staff_name, count(*)::int n from orders group by 1 order by 1`)
    expect(per.map((p) => p.n)).toEqual([15, 15, 15, 15])
  }, 120_000)

  it('同じ request_id を 12 並列で送っても 1 件だけ登録され、残りは duplicate', async () => {
    const { staff, oden } = await newWorld()
    const req = randomUUID()
    const results = await settle(
      Array.from({ length: 12 }, (_, i) =>
        call(staff[i % 4], 'create_order', { p_request_id: req, p_items: [{ product_id: oden.id, qty: 2 }], p_received: 1000 }),
      ),
    )
    const values = results.map(ok)
    expect(values.every((v) => v !== null)).toBe(true)
    expect(values.filter((v) => v!.duplicate === false)).toHaveLength(1)
    expect(new Set(values.map((v) => v!.order.id)).size).toBe(1)
    const [{ n }] = await admin<{ n: number }>(`select count(*)::int n from orders`)
    expect(n).toBe(1)
    const [{ c }] = await admin<{ c: number }>(`select count(*)::int c from cash_events where kind = 'sale'`)
    expect(c).toBe(1)
  }, 60_000)

  it('同じ注文の提供完了を 10 並列で押しても、提供は 1 回だけ(二重提供なし)', async () => {
    const { staff, oden } = await newWorld()
    const o = (await call(staff[0], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: oden.id, qty: 4 }], p_received: 2000 })).order
    const results = await settle(Array.from({ length: 10 }, (_, i) => call(staff[i % 4], 'serve_order', { p_order: o.id })))
    const values = results.map(ok)
    expect(values.every((v) => v !== null)).toBe(true)
    expect(values.filter((v) => v!.already_served === false)).toHaveLength(1)
    const [{ n, d }] = await admin<{ n: number; d: number }>(`select count(*)::int n, sum(delta)::int d from serve_events`)
    expect(n).toBe(1)
    expect(d).toBe(4)
  }, 60_000)

  it('品目の提供数量(比較更新): 同時に 0→1 を 10 人が押しても 1 回だけ反映、他は conflict', async () => {
    const { staff, oden } = await newWorld()
    const o = (await call(staff[0], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: oden.id, qty: 5 }], p_received: 3000 })).order
    const itemId = o.items[0].id
    const results = await settle(Array.from({ length: 10 }, (_, i) => call(staff[i % 4], 'serve_item', { p_item: itemId, p_from: 0, p_to: 1 })))
    const values = results.map(ok)
    expect(values.every((v) => v !== null)).toBe(true)
    expect(values.filter((v) => v!.ok === true)).toHaveLength(1)
    expect(values.filter((v) => v!.ok === false && v!.reason === 'conflict')).toHaveLength(9)
    const [{ q }] = await admin<{ q: number }>(`select served_qty q from order_items where id = $1`, [itemId])
    expect(q).toBe(1)
  }, 60_000)

  it('同じ注文の返金を 8 並列で押しても返金は 1 回だけ', async () => {
    const { boss, staff, oden } = await newWorld(0)
    const o = (await call(staff[0], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: oden.id, qty: 2 }], p_received: 1000 })).order
    const results = await settle(Array.from({ length: 8 }, () => call(boss, 'void_order', { p_order: o.id, p_reason: 'dup' })))
    const values = results.map(ok)
    expect(values.every((v) => v !== null)).toBe(true)
    expect(values.filter((v) => v!.already_voided === false)).toHaveLength(1)
    const [{ n, s }] = await admin<{ n: number; s: number }>(`select count(*)::int n, coalesce(sum(amount),0)::int s from cash_events where kind = 'refund'`)
    expect(n).toBe(1)
    expect(s).toBe(-1000)
    const [{ bal }] = await admin<{ bal: number }>(`select sum(amount)::int bal from cash_events`)
    expect(bal).toBe(0)
  }, 60_000)

  it('現金の回収を同時に行っても残高がマイナスにならない', async () => {
    const { boss } = await newWorld(1000)
    const results = await settle(
      Array.from({ length: 10 }, () => call(boss, 'record_cash_event', { p_request_id: randomUUID(), p_kind: 'collect', p_amount: 300, p_note: null })),
    )
    const succeeded = results.filter((r) => r.status === 'fulfilled').length
    expect(succeeded).toBe(3) // 1000 円から 300 円ずつ → 3 回まで
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected.every((r) => String(r.reason.message) === 'insufficient_cash')).toBe(true)
    const [{ bal }] = await admin<{ bal: number }>(`select sum(amount)::int bal from cash_events`)
    expect(bal).toBe(100)
  }, 60_000)

  it('会計・提供・返金・回収を同時に混ぜてもデッドロックせず、残高と数量の不変条件が保たれる', async () => {
    const { boss, staff, oden } = await newWorld(30000)
    for (let round = 0; round < 4; round++) {
      const orders: any[] = []
      for (let i = 0; i < 16; i++) {
        orders.push((await call(staff[i % 4], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: oden.id, qty: (i % 3) + 1 }], p_received: 5000 })).order)
      }
      const jobs: Promise<unknown>[] = []
      orders.forEach((o, i) => {
        jobs.push(call(staff[i % 4], 'serve_order', { p_order: o.id }))
        jobs.push(call(staff[(i + 1) % 4], 'serve_item', { p_item: o.items[0].id, p_from: 0, p_to: 1 }))
        jobs.push(call(staff[(i + 3) % 4], 'unserve_order', { p_order: o.id }))
        if (i % 3 === 0) jobs.push(call(boss, 'void_order', { p_order: o.id, p_reason: 'chaos' }))
        if (i % 4 === 0) jobs.push(call(boss, 'record_cash_event', { p_request_id: randomUUID(), p_kind: 'collect', p_amount: 100, p_note: null }))
        jobs.push(call(staff[(i + 2) % 4], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: oden.id, qty: 1 }], p_received: 500 }))
      })
      const results = await settle(jobs)
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      const deadlocks = rejected.filter((r) => /deadlock|serialization|40P01|40001/i.test(String(r.reason?.message ?? '')))
      expect(deadlocks.map((r) => `${r.reason?.message} | ${String(r.reason?.detail ?? '').slice(0, 300)}`)).toEqual([])
      // 起こり得るエラーは「返金済みの注文を提供しようとした」程度
      expect(rejected.map((r) => String(r.reason?.message)).filter((m) => m !== 'order_voided')).toEqual([])
    }

    const [{ bal }] = await admin<{ bal: number }>(`select sum(amount)::int bal from cash_events`)
    const [{ sales }] = await admin<{ sales: number }>(`select coalesce(sum(total),0)::int sales from orders where status = 'paid'`)
    const [{ col }] = await admin<{ col: number }>(`select coalesce(-sum(amount),0)::int col from cash_events where kind = 'collect'`)
    expect(bal).toBe(30000 + sales - col)
    const bad = await admin(`select 1 from order_items where served_qty > qty or served_qty < 0`)
    expect(bad).toHaveLength(0)
    const dup = await admin(`select order_no from orders group by order_no having count(*) > 1`)
    expect(dup).toHaveLength(0)
    // 提供イベントの合計 = 提供済み数量の合計(取消も差分として記録される)
    const [{ ev }] = await admin<{ ev: number }>(`select coalesce(sum(delta),0)::int ev from serve_events`)
    const [{ sv }] = await admin<{ sv: number }>(`select coalesce(sum(served_qty),0)::int sv from order_items`)
    expect(ev).toBe(sv)
  }, 240_000)

  it('会計とレジ締めが同時でも、締め時点の理論残高に含まれた注文だけが成立し、締め後の会計は拒否される', async () => {
    const { boss, staff, oden } = await newWorld(10000)
    const jobs = [
      ...Array.from({ length: 24 }, (_, i) => call(staff[i % 4], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: oden.id, qty: 1 }], p_received: 500 })),
    ]
    const day = (await admin<{ id: string }>(`select id from business_days`))[0]
    jobs.splice(10, 0, call(boss, 'close_business_day', { p_day: day.id, p_denoms: { '10000': 1 }, p_note: 'race', p_force: true }) as Promise<any>)
    const results = await settle(jobs)
    const orderResults = results.filter((_, i) => i !== 10)
    const failed = orderResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(failed.every((r) => String(r.reason.message) === 'no_open_day')).toBe(true)
    const [{ n }] = await admin<{ n: number }>(`select count(*)::int n from orders`)
    expect(n).toBe(orderResults.length - failed.length)
    const [d] = await admin<{ expected_cash: number; status: string; closed_at: string }>(`select expected_cash, status, closed_at from business_days`)
    expect(d.status).toBe('closed')
    expect(d.expected_cash).toBe(10000 + n * 500)
    const late = await admin(`select 1 from orders where created_at > $1`, [d.closed_at])
    expect(late).toHaveLength(0)
  }, 120_000)
})
