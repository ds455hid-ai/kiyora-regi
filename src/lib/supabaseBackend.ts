import { createClient } from '@supabase/supabase-js'
import type { Backend, SyncStatus } from './backend'
import { AppError } from './errors'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env'
import { getStaffName } from './staff'

const TABLES = ['products', 'business_days', 'orders', 'order_items', 'serve_events', 'cash_events'] as const

function isNetworkError(err: { message?: string; name?: string; status?: number } | null | undefined): boolean {
  if (!err) return false
  const msg = (err.message ?? '').toLowerCase()
  return (
    err.status === 0 ||
    err.name === 'TypeError' ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  )
}

/** すべてのリクエストに担当者名(x-staff-name, パーセントエンコード)を付ける */
const fetchWithStaffName: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  const name = getStaffName()
  if (name) headers.set('x-staff-name', encodeURIComponent(name))
  return fetch(input, { ...init, headers })
}

export function createSupabaseBackend(): Backend {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchWithStaffName },
  })

  return {
    kind: 'supabase',

    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      let res
      try {
        res = await client.rpc(fn, args)
      } catch {
        throw new AppError('network', undefined, true)
      }
      if (res.error) {
        const err = res.error as { message?: string; details?: string | null; code?: string; name?: string }
        if (isNetworkError({ message: err.message, name: err.name, status: res.status })) {
          throw new AppError('network', undefined, true)
        }
        // DB の raise exception 'code' [using detail = ...]
        throw new AppError(err.message ?? 'unknown', err.details ?? undefined)
      }
      return res.data as T
    },

    subscribe(cb: () => void, onStatus: (s: SyncStatus) => void) {
      const channel = client.channel('pos-sync')
      for (const table of TABLES) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb())
      }
      onStatus('connecting')
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') onStatus('connected')
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') onStatus('disconnected')
      })
      return () => {
        void client.removeChannel(channel)
      }
    },
  }
}
