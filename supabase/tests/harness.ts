import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const MIGRATION = readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')

/** Supabase と同等のロール / auth スキーマ / デフォルト権限(本番と同じ SQL を流す前の下準備) */
export const SUPABASE_STUB_SQL = `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;

    create schema auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $$;
    create publication supabase_realtime;

    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

export async function createDb() {
  const db = new PGlite()
  await db.exec(SUPABASE_STUB_SQL)
  await db.exec(MIGRATION)
  return db
}

export type Db = Awaited<ReturnType<typeof createDb>>

export async function signUp(db: Db, name: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
    [id, `${name}@example.com`, JSON.stringify({ display_name: name })],
  )
  return id
}

/** uid が null なら anon、それ以外は authenticated としてクエリを実行 */
export async function as<T>(db: Db, uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  }
}

/** RPC を名前付き引数で呼ぶ(PostgREST の rpc と同じ形) */
export async function rpc<T = any>(db: Db, uid: string | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const keys = Object.keys(args)
  const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
  const values = keys.map((k) => {
    const v = args[k]
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
  })
  return as(db, uid, async () => {
    const res = await db.query<{ r: T }>(`select public.${fn}(${params}) as r`, values)
    return res.rows[0].r
  })
}

export async function rpcError(db: Db, uid: string | null, fn: string, args: Record<string, unknown> = {}) {
  try {
    await rpc(db, uid, fn, args)
  } catch (e: any) {
    return { message: String(e.message ?? e), detail: e.detail as string | undefined, code: e.code as string | undefined }
  }
  return null
}

export async function query<T = any>(db: Db, uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return as(db, uid, async () => (await db.query<T>(sql, params)).rows)
}

export async function queryError(db: Db, uid: string | null, sql: string, params: unknown[] = []) {
  try {
    await query(db, uid, sql, params)
  } catch (e: any) {
    return String(e.message ?? e)
  }
  return null
}

/** 管理者 + スタッフ 2 人 + 営業開始済みの標準セットアップ */
export async function seedWorld(db: Db, opts: { openFloat?: number } = {}) {
  const admin = await signUp(db, '店長')
  const alice = await signUp(db, 'アリス')
  const bob = await signUp(db, 'ボブ')
  await rpc(db, admin, 'admin_update_staff', { p_user: alice, p_active: true, p_role: 'staff' })
  await rpc(db, admin, 'admin_update_staff', { p_user: bob, p_active: true, p_role: 'staff' })
  const float = opts.openFloat ?? 10000
  const day = await rpc(db, admin, 'open_business_day', { p_float: float, p_denoms: null, p_date: '2026-10-10' })
  const products = await query<{ id: string; name: string; price: number }>(db, admin, `select id, name, price from products order by sort_order`)
  return { admin, alice, bob, day, oden: products[0] }
}

export async function addProduct(db: Db, admin: string, name: string, price: number, sort = 20) {
  return rpc<{ id: string; name: string; price: number }>(db, admin, 'upsert_product', {
    p_id: null, p_name: name, p_price: price, p_category: 'drink', p_sort_order: sort, p_visible: true,
  })
}

export const uuid = () => randomUUID()
