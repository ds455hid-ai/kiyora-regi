export type Cell = string | number | null | undefined

function escapeCell(v: Cell): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Excel で文字化けしないよう BOM 付き・CRLF の CSV を作る */
export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((r) => r.map(escapeCell).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

/** ファイルを保存。ホーム画面アプリ(iPhone)では共有シート、ブラウザではダウンロード。 */
export async function saveTextFile(filename: string, text: string, mime = 'text/csv'): Promise<'shared' | 'downloaded'> {
  const file = new File([text], filename, { type: `${mime};charset=utf-8` })
  if (isStandalone() && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'shared'
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
