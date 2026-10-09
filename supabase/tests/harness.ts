import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')
/** 001(基本スキーマ) + 002(ログインなしモード)。本番と同じ順で流す */
export const MIGRATION = read('001_init.sql') + '\n' + read('002_open_access.sql')

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

/** 端末が送る x-staff-name ヘッダー(パーセントエンコード)を PostgREST と同じ形で再現 */
const headersFor = (who: string | null) =>
  JSON.stringify(who === null ? {} : { 'x-staff-name': encodeURIComponent(who) })

/** who = スタッフ名(未ログインの anon として実行し、名前だけをヘッダーで渡す) */
export async function as<T>(db: Db, who: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.headers', $1, false)`, [headersFor(who)])
  await db.exec('set role anon')
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.headers', '', false)`)
  }
}

/** RPC を名前付き引数で呼ぶ(PostgREST の rpc と同じ形) */
export async function rpc<T = any>(db: Db, who: string | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const keys = Object.keys(args)
  const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
  const values = keys.map((k) => {
    const v = args[k]
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
  })
  return as(db, who, async () => {
    const res = await db.query<{ r: T }>(`select public.${fn}(${params}) as r`, values)
    return res.rows[0].r
  })
}

export async function rpcError(db: Db, who: string | null, fn: string, args: Record<string, unknown> = {}) {
  try {
    await rpc(db, who, fn, args)
  } catch (e: any) {
    return { message: String(e.message ?? e), detail: e.detail as string | undefined, code: e.code as string | undefined }
  }
  return null
}

export async function query<T = any>(db: Db, who: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return as(db, who, async () => (await db.query<T>(sql, params)).rows)
}

export async function queryError(db: Db, who: string | null, sql: string, params: unknown[] = []) {
  try {
    await query(db, who, sql, params)
  } catch (e: any) {
    return String(e.message ?? e)
  }
  return null
}

export const ADMIN = '店長'
export const ALICE = 'アリス'
export const BOB = 'ボブ'

/** 営業開始済みの標準セットアップ(ログインなし。名前は文字列で渡すだけ) */
export async function seedWorld(db: Db, opts: { openFloat?: number } = {}) {
  const float = opts.openFloat ?? 10000
  const day = await rpc(db, ADMIN, 'open_business_day', { p_float: float, p_denoms: null, p_date: '2026-10-10' })
  const products = await query<{ id: string; name: string; price: number }>(db, ADMIN, `select id, name, price from products order by sort_order`)
  return { admin: ADMIN, alice: ALICE, bob: BOB, day, oden: products[0] }
}

export async function addProduct(db: Db, who: string, name: string, price: number, sort = 200) {
  return rpc<{ id: string; name: string; price: number }>(db, who, 'upsert_product', {
    p_id: null, p_name: name, p_price: price, p_category: 'drink', p_sort_order: sort, p_visible: true,
  })
}

export const uuid = () => randomUUID()
