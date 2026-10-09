// 開発用バックエンド: ブラウザ内の PostgreSQL(PGlite)に本番と同じマイグレーション SQL を流して動かす。
// 本番ビルドには含まれない(backend.ts の import.meta.env 分岐で除去される)。
import { PGlite } from '@electric-sql/pglite'
import migrationSql from '../../supabase/migrations/001_init.sql?raw'
import openAccessSql from '../../supabase/migrations/002_open_access.sql?raw'
import type { Backend, SyncStatus } from './backend'
import { AppError } from './errors'
import { getStaffName } from './staff'

const STUB_SQL = `
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
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create publication supabase_realtime;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

export type MockBackend = Backend & {
  dev: {
    /** 次の n 回の create_order を「DBには反映されたが応答が失われた」状態にする(通信断の再現) */
    loseNextResponses(n: number): void
  }
}

export async function createMockBackend(): Promise<MockBackend> {
  const db = new PGlite()
  await db.exec(STUB_SQL)
  await db.exec(migrationSql)
  await db.exec(openAccessSql)

  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  const listeners = new Set<() => void>()
  const emit = () => setTimeout(() => listeners.forEach((l) => l()), 0)

  /** 本番と同じ: 未ログイン(anon)として実行し、担当者名は x-staff-name ヘッダー相当で渡す */
  const rpcAs = <T>(name: string, fn: string, args: Record<string, unknown>): Promise<T> => {
    const keys = Object.keys(args)
    const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
    const values = keys.map((k) => {
      const v = args[k]
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
    })
    return serial(async () => {
      const headers = JSON.stringify(name ? { 'x-staff-name': encodeURIComponent(name) } : {})
      await db.query(`select set_config('request.headers', $1, false)`, [headers])
      await db.exec('set role anon')
      try {
        return (await db.query<{ r: T }>(`select public.${fn}(${params}) as r`, values)).rows[0].r
      } finally {
        await db.exec('reset role')
      }
    })
  }

  // ---- 初期データ: 営業日 1(釣銭 10,000 円) ----
  await rpcAs('店長', 'open_business_day', { p_float: 10000, p_denoms: null, p_date: null })

  let loseResponses = 0

  const backend: MockBackend = {
    kind: 'mock',
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      try {
        const r = await rpcAs<T>(getStaffName(), fn, args)
        emit()
        if (loseResponses > 0 && fn === 'create_order') {
          loseResponses--
          throw new AppError('network', undefined, true)
        }
        return r
      } catch (e) {
        if (e instanceof AppError) throw e
        const err = e as { message?: string; detail?: string }
        throw new AppError(err.message ?? 'unknown', err.detail)
      }
    },
    subscribe(cb: () => void, onStatus: (s: SyncStatus) => void) {
      listeners.add(cb)
      onStatus('connected')
      return () => listeners.delete(cb)
    },
    dev: {
      loseNextResponses(n: number) {
        loseResponses = n
      },
    },
  }
  ;(window as unknown as { __mock?: MockBackend['dev'] }).__mock = backend.dev
  return backend
}
