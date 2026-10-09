import { useState, type FormEvent } from 'react'
import { cleanStaffName, setStaffName } from '../lib/staff'

/** ログイン不要。会計・提供の記録に使う「担当者名」を、この端末に保存するだけ。 */
export function NameForm({ initial = '', submitLabel, onDone }: { initial?: string; submitLabel: string; onDone?: () => void }) {
  const [name, setName] = useState(initial)
  const ok = cleanStaffName(name).length > 0

  function submit(ev: FormEvent) {
    ev.preventDefault()
    if (!ok) return
    setStaffName(name)
    onDone?.()
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        お名前(ニックネームでOK)
        <input
          className="input"
          value={name}
          maxLength={30}
          autoFocus
          autoComplete="nickname"
          placeholder="例: たろう"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button className="btn primary block" type="submit" disabled={!ok}>{submitLabel}</button>
      <p className="hint" style={{ margin: 0 }}>
        会計・提供の記録に表示される名前です。この端末に保存され、パスワードは要りません。
      </p>
    </form>
  )
}

export function NameScreen() {
  return (
    <div className="auth">
      <img className="logo" src={`${import.meta.env.BASE_URL}pwa-192.png`} alt="" />
      <h1>屋台レジ</h1>
      <p style={{ margin: 0 }}>はじめに、この端末で使う名前を入れてください。</p>
      <NameForm submitLabel="はじめる" />
    </div>
  )
}
