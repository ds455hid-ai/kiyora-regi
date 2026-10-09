const LEGACY_PREFIX = 'kiyoraRegi_' // v1(旧レジ)が localStorage に保存していたキー

export interface LegacyData {
  keys: string[]
  historyCount: number
  json: string
}

/** 旧レジのブラウザ内データを読み出す(削除はしない) */
export function readLegacyData(): LegacyData {
  const data: Record<string, unknown> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(LEGACY_PREFIX)) continue
      const raw = localStorage.getItem(k)
      try {
        data[k] = raw === null ? null : JSON.parse(raw)
      } catch {
        data[k] = raw
      }
    }
  } catch {
    /* localStorage が使えない環境 */
  }
  const history = data['kiyoraRegi_history']
  return {
    keys: Object.keys(data),
    historyCount: Array.isArray(history) ? history.length : 0,
    json: JSON.stringify({ exportedAt: new Date().toISOString(), source: 'kiyora-regi v1', data }, null, 2),
  }
}
