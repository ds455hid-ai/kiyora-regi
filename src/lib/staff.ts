// ログインなし: 会計などの担当者名は、端末ごとに最初に入力した名前(ブラウザ内に保存)を使う。
const KEY = 'kiyoraRegi2_staffName'

export const cleanStaffName = (n: string) => n.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30)

function read(): string {
  try {
    return cleanStaffName(localStorage.getItem(KEY) ?? '')
  } catch {
    return ''
  }
}

let current = read()
const listeners = new Set<() => void>()

export const getStaffName = () => current

export function setStaffName(name: string): void {
  current = cleanStaffName(name)
  try {
    localStorage.setItem(KEY, current)
  } catch {
    /* 保存できなくても、この画面を開いている間は使える */
  }
  listeners.forEach((l) => l())
}

export function subscribeStaffName(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
