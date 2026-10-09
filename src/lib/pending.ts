const KEY = 'kiyoraRegi2_pendingOrder'

/** 通信エラーで結果が不明な会計。同じ requestId で再送すれば二重登録にならない。 */
export interface PendingOrder {
  requestId: string
  items: { product_id: string; qty: number }[]
  received: number
  total: number
  summary: string
  createdAt: number
}

export function loadPending(): PendingOrder | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as PendingOrder) : null
  } catch {
    return null
  }
}

export function savePending(p: PendingOrder): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 保存できなくても会計自体は続行 */
  }
}

export function clearPending(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function newRequestId(): string {
  return crypto.randomUUID()
}
