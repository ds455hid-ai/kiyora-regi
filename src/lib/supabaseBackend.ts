import { createClient } from '@supabase/supabase-js'
import type { Backend, SessionInfo, SyncStatus } from './backend'
import { AppError } from './errors'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env'

const TABLES = ['products', 'business_days', 'orders', 'order_items', 'serve_events', 'cash_events', 'profiles'] as const

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

export function createSupabaseBackend(): Backend {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })

  return {
    kind: 'supabase',
    auth: {
      async getSession(): Promise<SessionInfo | null> {
        const { data } = await client.auth.getSession()
        const s = data.session
        return s ? { userId: s.user.id, email: s.user.email ?? undefined } : null
      },
      async signIn(email, password) {
        const { error } = await client.auth.signInWithPassword({ email, password })
        if (error) {
          if (isNetworkError(error)) throw new AppError('network', undefined, true)
          throw new AppError('auth_failed', error.message)
        }
      },
      async signUp(email, password, displayName) {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName } },
        })
        if (error) {
          if (isNetworkError(error)) throw new AppError('network', undefined, true)
          throw new AppError('signup_failed', error.message)
        }
        return { signedIn: !!data.session }
      },
      async signOut() {
        await client.auth.signOut()
      },
      onChange(cb) {
        const { data } = client.auth.onAuthStateChange(() => cb())
        return () => data.subscription.unsubscribe()
      },
    },

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
