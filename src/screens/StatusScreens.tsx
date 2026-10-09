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

export function ConnectError() {
  const { refresh } = useApp()
  return (
    <div className="center-screen">
      <div className="card stack" style={{ maxWidth: 420 }}>
        <div className="h2">サーバーに接続できません</div>
        <p style={{ margin: 0 }}>電波の良い場所で、もう一度お試しください。</p>
        <button className="btn primary" onClick={() => void refresh()}>再試行</button>
      </div>
    </div>
  )
}
