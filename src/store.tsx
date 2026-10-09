import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react'
import { makeApi, READ_ONLY_RPCS, type Api } from './lib/api'
import { loadBackend, type Backend, type SessionInfo, type SyncStatus } from './lib/backend'
import { IS_CONFIGURED } from './lib/env'
import { AppError } from './lib/errors'
import type { Order, Snapshot } from './lib/types'

export type Conn = 'online' | 'degraded' | 'offline'
export type Phase = 'loading' | 'unconfigured' | 'anon' | 'error' | 'pending' | 'ready'
export type ToastKind = 'info' | 'ok' | 'error'

interface Toast {
  id: number
  text: string
  kind: ToastKind
}

interface Ctx {
  phase: Phase
  backend: Backend | null
  session: SessionInfo | null
  snapshot: Snapshot | null
  conn: Conn
  api: Api
  refresh: () => Promise<void>
  patchOrder: (o: Order) => void
  toast: (text: string, kind?: ToastKind) => void
  toasts: Toast[]
  signOut: () => Promise<void>
}

const AppContext = createContext<Ctx | null>(null)

export function useApp(): Ctx {
  const c = useContext(AppContext)
  if (!c) throw new Error('AppProvider が必要です')
  return c
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [backend, setBackend] = useState<Backend | null>(null)
  const [booted, setBooted] = useState(false)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('connecting')
  const [online, setOnline] = useState(() => navigator.onLine)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])

  const inflight = useRef<Promise<void> | null>(null)
  const rerun = useRef(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastOk = useRef(0)
  const toastId = useRef(0)
  const syncRef = useRef<SyncStatus>('connecting')
  const failedRef = useRef(false)

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++toastId.current
    setToasts((t) => [...t.slice(-3), { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200)
  }, [])

  syncRef.current = syncStatus
  failedRef.current = refreshFailed

  // ---- バックエンド読み込み & セッション ----
  useEffect(() => {
    if (!IS_CONFIGURED) {
      setBooted(true)
      return
    }
    let off: (() => void) | undefined
    let cancelled = false
    void (async () => {
      const b = await loadBackend()
      if (cancelled) return
      setBackend(b)
      setSession(await b.auth.getSession())
      off = b.auth.onChange(() => {
        void b.auth.getSession().then((s) => !cancelled && setSession(s))
      })
      setBooted(true)
    })()
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  // ---- スナップショット取得(多重実行を1回にまとめる) ----
  const refresh = useCallback(async (): Promise<void> => {
    if (!backend) return
    if (inflight.current) {
      rerun.current = true
      return inflight.current
    }
    const run = (async () => {
      try {
        const s = await backend.rpc<Snapshot>('app_snapshot')
        setSnapshot(s)
        lastOk.current = Date.now()
        setRefreshFailed(false)
      } catch (e) {
        if (e instanceof AppError && e.network) setRefreshFailed(true)
        else if (e instanceof AppError && (e.code === 'forbidden' || /jwt|permission denied/i.test(e.code))) {
          setSnapshot(null)
        } else setRefreshFailed(true)
      } finally {
        inflight.current = null
        if (rerun.current) {
          rerun.current = false
          void refresh()
        }
      }
    })()
    inflight.current = run
    return run
  }, [backend])

  const scheduleRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void refresh(), 150)
  }, [refresh])

  // ---- ログイン中: 初回取得 + リアルタイム購読 + 再接続時の再取得 ----
  useEffect(() => {
    if (!backend || !session) {
      setSnapshot(null)
      return
    }
    void refresh()
    const unsub = backend.subscribe(scheduleRefresh, setSyncStatus)

    const onOnline = () => {
      setOnline(true)
      void refresh()
    }
    const onOffline = () => setOnline(false)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)

    // 保険のポーリング: 切断中は 5 秒ごと、通常は 45 秒ごとに再取得
    const timer = setInterval(() => {
      const stale = Date.now() - lastOk.current
      if (stale > 45_000 || syncRef.current !== 'connected' || failedRef.current) void refresh()
    }, 5_000)

    return () => {
      unsub()
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [backend, session, refresh, scheduleRefresh])

  const conn: Conn = !online || refreshFailed ? 'offline' : syncStatus === 'connected' ? 'online' : 'degraded'

  // 一度つながった後で再接続したときだけお知らせ(初回接続では出さない)
  const prevConn = useRef<Conn>('degraded')
  const everOnline = useRef(false)
  useEffect(() => {
    if (conn === 'online') {
      if (everOnline.current && prevConn.current !== 'online') toast('再接続しました。最新の情報に更新しました', 'ok')
      everOnline.current = true
    }
    prevConn.current = conn
  }, [conn, toast])

  // ---- RPC ラッパー(書き込み成功後は再取得) ----
  const api = useMemo<Api>(() => {
    const rpc = async <T,>(fn: string, args?: Record<string, unknown>): Promise<T> => {
      if (!backend) throw new AppError('network', undefined, true)
      try {
        const r = await backend.rpc<T>(fn, args)
        if (!READ_ONLY_RPCS.has(fn)) scheduleRefresh()
        return r
      } catch (e) {
        if (e instanceof AppError && e.network) setRefreshFailed(true)
        throw e
      }
    }
    return makeApi(rpc)
  }, [backend, scheduleRefresh])

  const patchOrder = useCallback((o: Order) => {
    setSnapshot((s) => {
      if (!s || !s.orders) return s
      const exists = s.orders.some((x) => x.id === o.id)
      const orders = exists ? s.orders.map((x) => (x.id === o.id ? o : x)) : [...s.orders, o].sort((a, b) => a.order_no - b.order_no)
      return { ...s, orders }
    })
  }, [])

  const signOut = useCallback(async () => {
    await backend?.auth.signOut()
    setSnapshot(null)
  }, [backend])

  let phase: Phase
  if (!booted) phase = 'loading'
  else if (!IS_CONFIGURED) phase = 'unconfigured'
  else if (!session) phase = 'anon'
  else if (!snapshot) phase = refreshFailed ? 'error' : 'loading'
  else if (!snapshot.me || !snapshot.me.active) phase = 'pending'
  else phase = 'ready'

  const value: Ctx = {
    phase, backend, session, snapshot, conn, api, refresh, patchOrder, toast, toasts, signOut,
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
