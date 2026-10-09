export const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1] as const
export const QUICK_CASH = [1000, 2000, 5000, 10000] as const
export const MAX_QTY = 99

export function cartTotal(lines: { price: number; qty: number }[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0)
}

/** お釣り(預かり不足なら負の値 = 不足額) */
export function changeOf(total: number, received: number): number {
  return received - total
}

export type DenomCounts = Partial<Record<number, number>>

export function denomsTotal(counts: DenomCounts): number {
  return DENOMS.reduce((sum, d) => sum + d * (counts[d] ?? 0), 0)
}

/** RPC に渡す形({"1000": 5, ...}。0枚は除く) */
export function denomsPayload(counts: DenomCounts): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of DENOMS) {
    const n = counts[d] ?? 0
    if (n > 0) out[String(d)] = n
  }
  return out
}

/** テンキー入力: 先頭ゼロ除去・桁数制限 */
export function pressDigit(current: string, digit: string, maxLen = 7): string {
  const next = current === '0' ? (digit === '00' ? '0' : digit) : current + digit
  return next.length > maxLen ? current : next
}

export function backspace(current: string): string {
  return current.length > 1 ? current.slice(0, -1) : '0'
}
