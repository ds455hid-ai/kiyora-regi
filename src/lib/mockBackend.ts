// 開発用バックエンド: ブラウザ内の PostgreSQL(PGlite)に本番と同じマイグレーション SQL を流して動かす。
// 本番ビルドには含まれない(backend.ts の import.meta.env 分岐で除去される)。
import { PGlite } from '@electric-sql/pglite'
import migrationSql from '../../supabase/migrations/001_init.sql?raw'
import type { Backend, SessionInfo, SyncStatus } from './backend'
import { AppError } from './errors'

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

export interface MockUser {
  id: string
  email: string
  name: string
  role: string
  active: boolean
}

export type MockBackend = Backend & {
  dev: {
    users(): Promise<MockUser[]>
    switchUser(id: string): Promise<void>
    /** 次の n 回の create_order を「DBには反映されたが応答が失われた」状態にする(通信断の再現) */
    loseNextResponses(n: number): void
  }
}

export async function createMockBackend(): Promise<MockBackend> {
  const db = new PGlite()
  await db.exec(STUB_SQL)
  await db.exec(migrationSql)

  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  const listeners = new Set<() => void>()
  const emit = () => setTimeout(() => listeners.forEach((l) => l()), 0)

  const withUser = <T>(uid: string | null, fn: () => Promise<T>) =>
    serial(async () => {
      await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
      await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
      try {
        return await fn()
      } finally {
        await db.exec('reset role')
      }
    })

  const addUser = async (name: string, email: string, fixedId?: string) => {
    const id = fixedId ?? crypto.randomUUID()
    await serial(() =>
      db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`, [
        id, email, JSON.stringify({ display_name: name }),
      ]),
    )
    return id
  }

  const rpcAs = async <T>(uid: string, fn: string, args: Record<string, unknown>): Promise<T> => {
    const keys = Object.keys(args)
    const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
    const values = keys.map((k) => {
      const v = args[k]
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v
    })
    return withUser(uid, async () => (await db.query<{ r: T }>(`select public.${fn}(${params}) as r`, values)).rows[0].r)
  }

  // ---- 初期データ: 管理者 1 + スタッフ 2、営業日 1(釣銭 10,000 円)、 ----
  // ID を固定して、ホットリロードで DB が作り直されてもログイン状態が壊れないようにする
  const adminId = await addUser('店長', 'admin@mock.test', '00000000-0000-4000-8000-000000000001')
  const aliceId = await addUser('アリス', 'alice@mock.test', '00000000-0000-4000-8000-000000000002')
  const bobId = await addUser('ボブ', 'bob@mock.test', '00000000-0000-4000-8000-000000000003')
  await rpcAs(adminId, 'admin_update_staff', { p_user: aliceId, p_active: true, p_role: 'staff', p_display_name: null })
  await rpcAs(adminId, 'admin_update_staff', { p_user: bobId, p_active: true, p_role: 'staff', p_display_name: null })
  await rpcAs(adminId, 'open_business_day', { p_float: 10000, p_denoms: null, p_date: null })

  let loseResponses = 0
  let currentUser: string | null = sessionStorage.getItem('mockUser')
  const authListeners = new Set<() => void>()
  const notifyAuth = () => authListeners.forEach((l) => l())

  const toAppError = (e: unknown): AppError => {
    const err = e as { message?: string; detail?: string }
    return new AppError(err.message ?? 'unknown', err.detail)
  }

  const backend: MockBackend = {
    kind: 'mock',
    auth: {
      async getSession(): Promise<SessionInfo | null> {
        return currentUser ? { userId: currentUser } : null
      },
      async signIn(email) {
        const rows = await serial(async () => (await db.query<{ id: string }>(`select id from auth.users where email = $1`, [email])).rows)
        if (!rows[0]) throw new AppError('auth_failed', 'Invalid login credentials')
        currentUser = rows[0].id
        sessionStorage.setItem('mockUser', currentUser)
        notifyAuth()
      },
      async signUp(email, _password, displayName) {
        const id = await addUser(displayName, email)
        currentUser = id
        sessionStorage.setItem('mockUser', id)
        notifyAuth()
        emit()
        return { signedIn: true }
      },
      async signOut() {
        currentUser = null
        sessionStorage.removeItem('mockUser')
        notifyAuth()
      },
      onChange(cb) {
        authListeners.add(cb)
        return () => authListeners.delete(cb)
      },
    },
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      if (!currentUser) throw new AppError('forbidden')
      try {
        const r = await rpcAs<T>(currentUser, fn, args)
        emit()
        if (loseResponses > 0 && fn === 'create_order') {
          loseResponses--
          throw new AppError('network', undefined, true)
        }
        return r
      } catch (e) {
        if (e instanceof AppError) throw e
        throw toAppError(e)
      }
    },
    subscribe(cb: () => void, onStatus: (s: SyncStatus) => void) {
      listeners.add(cb)
      onStatus('connected')
      return () => listeners.delete(cb)
    },
    dev: {
      async users() {
        return serial(async () =>
          (await db.query<MockUser>(
            `select u.id, u.email, p.display_name as name, p.role, p.active
               from auth.users u join public.profiles p on p.id = u.id order by p.created_at`,
          )).rows,
        )
      },
      async switchUser(id: string) {
        currentUser = id
        sessionStorage.setItem('mockUser', id)
        notifyAuth()
      },
      loseNextResponses(n: number) {
        loseResponses = n
      },
    },
  }
  ;(window as unknown as { __mock?: MockBackend['dev'] }).__mock = backend.dev
  return backend
}
