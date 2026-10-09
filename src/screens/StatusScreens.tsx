import { useApp } from '../store'

export function Loading() {
  return (
    <div className="center-screen">
      <div>
        <img className="logo" src={`${import.meta.env.BASE_URL}pwa-192.png`} alt="" />
        <p className="muted" style={{ fontWeight: 700 }}>読み込み中…</p>
      </div>
    </div>
  )
}

export function Unconfigured() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ maxWidth: 460, textAlign: 'left' }}>
        <div className="h2">Supabase が未設定です</div>
        <p style={{ margin: 0 }}>
          このアプリはデータの保存・端末間の共有に Supabase を使います。接続情報(Project URL と anon key)がまだ設定されていません。
        </p>
        <p className="hint" style={{ margin: 0 }}>
          リポジトリの <b>docs/SETUP.md</b> の手順に沿って設定してください。設定が終わるまで、旧レジは
          <a href={`${import.meta.env.BASE_URL}legacy/index.html`}> こちら</a> から引き続き使えます。
        </p>
      </div>
    </div>
  )
}

export function PendingApproval() {
  const { signOut, snapshot, refresh } = useApp()
  const noProfile = !snapshot?.me
  return (
    <div className="center-screen">
      <div className="card stack" style={{ maxWidth: 420 }}>
        <div className="h2">{noProfile ? 'アカウント情報が見つかりません' : '管理者の承認待ちです'}</div>
        <p style={{ margin: 0 }}>
          {noProfile
            ? '一度ログアウトして、もう一度ログインしてください。'
            : `「${snapshot?.me?.display_name}」さんの登録を受け付けました。管理者が承認すると、自動でレジが使えるようになります。`}
        </p>
        <button className="btn" onClick={() => void refresh()}>承認されたか確認する</button>
        <button className="btn ghost" onClick={() => void signOut()}>ログアウト</button>
      </div>
    </div>
  )
}

export function ConnectError() {
  const { refresh, signOut } = useApp()
  return (
    <div className="center-screen">
      <div className="card stack" style={{ maxWidth: 420 }}>
        <div className="h2">サーバーに接続できません</div>
        <p style={{ margin: 0 }}>電波の良い場所で、もう一度お試しください。</p>
        <button className="btn primary" onClick={() => void refresh()}>再試行</button>
        <button className="btn ghost" onClick={() => void signOut()}>ログアウト</button>
      </div>
    </div>
  )
}
