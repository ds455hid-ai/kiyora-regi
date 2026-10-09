export interface SessionInfo {
  userId: string
  email?: string
}

export type SyncStatus = 'connecting' | 'connected' | 'disconnected'

export interface Backend {
  readonly kind: 'supabase' | 'mock'
  auth: {
    getSession(): Promise<SessionInfo | null>
    signIn(email: string, password: string): Promise<void>
    signUp(email: string, password: string, displayName: string): Promise<{ signedIn: boolean }>
    signOut(): Promise<void>
    onChange(cb: () => void): () => void
  }
  /** DB の RPC(security definer 関数)を呼ぶ。失敗は AppError を throw。 */
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>
  /** 変更通知(Realtime)。cb は変更があるたびに呼ばれる。戻り値で購読解除。 */
  subscribe(cb: () => void, onStatus: (s: SyncStatus) => void): () => void
}

let cached: Promise<Backend> | null = null

/**
 * バックエンドは 1 つだけ作る(React StrictMode の二重実行でクライアントが重複しないように)。
 * 本番ビルドでは mock 分岐ごと除去される(import.meta.env が定数に置換されるため)。
 */
export function loadBackend(): Promise<Backend> {
  if (!cached) {
    cached = (async () => {
      if (import.meta.env.VITE_BACKEND === 'mock') {
        const m = await import('./mockBackend')
        return m.createMockBackend()
      }
      const m = await import('./supabaseBackend')
      return m.createSupabaseBackend()
    })()
  }
  return cached
}
