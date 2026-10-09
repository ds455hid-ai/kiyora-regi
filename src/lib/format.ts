export const yen = (n: number) => (n < 0 ? '-¥' : '¥') + Math.abs(n).toLocaleString('ja-JP')

export const signedYen = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '±') + '¥' + Math.abs(n).toLocaleString('ja-JP')

export const orderNo = (n: number) => String(n).padStart(3, '0')

export const hm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })

export const dateJa = (isoDate: string) => {
  const d = new Date(isoDate + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})`
}

export const dateTimeJa = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${hm(iso)}`
}

/** CSV 用: 日本時間の 'YYYY-MM-DD HH:mm:ss' */
export const fullJst = (iso: string | null | undefined) => {
  if (!iso) return ''
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(iso))
  return parts
}
