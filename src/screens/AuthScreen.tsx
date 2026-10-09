import { useState, type FormEvent } from 'react'
import { AppError } from '../lib/errors'
import { useApp } from '../store'

function authMessage(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code === 'network') return '通信できませんでした。電波の良い場所で再度お試しください'
    const m = (e.detail ?? '').toLowerCase()
    if (m.includes('invalid login')) return 'メールアドレスまたはパスワードが違います'
    if (m.includes('not confirmed')) return 'メールの確認が完了していません。届いたメールのリンクを開いてください'
    if (m.includes('already registered') || m.includes('already been registered')) return 'このメールアドレスはすでに登録されています。ログインしてください'
    if (m.includes('password')) return 'パスワードは8文字以上にしてください'
    if (m.includes('rate limit')) return '短時間に何度も試行されました。少し待ってからお試しください'
    return e.detail || '認証に失敗しました'
  }
  return '認証に失敗しました'
}

export function AuthScreen() {
  const { backend, toast } = useApp()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    if (!backend || busy) return
    setError(null)
    if (mode === 'signup') {
      if (name.trim().length === 0) return setError('スタッフ名を入力してください')
      if (password.length < 8) return setError('パスワードは8文字以上にしてください')
    }
    setBusy(true)
    try {
      if (mode === 'login') {
        await backend.auth.signIn(email.trim(), password)
      } else {
        const r = await backend.auth.signUp(email.trim(), password, name.trim())
        if (!r.signedIn) toast('確認メールを送信しました。メール内のリンクを開いてからログインしてください', 'ok')
      }
    } catch (e) {
      setError(authMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="auth" onSubmit={submit}>
      <img className="logo" src={`${import.meta.env.BASE_URL}pwa-192.png`} alt="" />
      <h1>屋台レジ</h1>
      <div className="seg" role="group" aria-label="ログインか新規登録か">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>ログイン</button>
        <button type="button" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>新規登録</button>
      </div>
      {mode === 'signup' && (
        <label className="field">
          スタッフ名(会計履歴に記録されます)
          <input className="input" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} autoComplete="nickname" required />
        </label>
      )}
      <label className="field">
        メールアドレス
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required />
      </label>
      <label className="field">
        パスワード{mode === 'signup' ? '(8文字以上)' : ''}
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
      </label>
      {error && <div className="err" role="alert">{error}</div>}
      <button className="btn primary block" disabled={busy} type="submit">
        {busy ? '処理中…' : mode === 'login' ? 'ログイン' : '登録する'}
      </button>
      {mode === 'signup' && (
        <p className="hint" style={{ margin: 0 }}>登録後、管理者が承認するとレジが使えるようになります(最初の登録者は管理者になります)。</p>
      )}
    </form>
  )
}
