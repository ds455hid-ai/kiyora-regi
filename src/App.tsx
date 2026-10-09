import { useCallback, useEffect, useState } from 'react'
import { Icon } from './components/Icon'
import { Toasts } from './components/Toasts'
import { dateJa } from './lib/format'
import type { MockBackend, MockUser } from './lib/mockBackend'
import { Admin } from './screens/Admin'
import { AuthScreen } from './screens/AuthScreen'
import { Cash } from './screens/Cash'
import { Handover } from './screens/Handover'
import { Register } from './screens/Register'
import { Sales } from './screens/Sales'
import { ConnectError, Loading, PendingApproval, Unconfigured } from './screens/StatusScreens'
import { useApp } from './store'

const TABS = [
  { id: 'register', label: 'レジ', icon: 'register' },
  { id: 'handover', label: '受け渡し', icon: 'handover' },
  { id: 'cash', label: '現金', icon: 'cash' },
  { id: 'sales', label: '売上', icon: 'sales' },
  { id: 'admin', label: '管理', icon: 'admin' },
] as const
type TabId = (typeof TABS)[number]['id']

function readTab(): TabId {
  const id = window.location.hash.replace(/^#\/?/, '')
  return (TABS.find((t) => t.id === id)?.id ?? 'register') as TabId
}

function useTab(): [TabId, (t: string) => void] {
  const [tab, setTab] = useState<TabId>(readTab)
  useEffect(() => {
    const on = () => setTab(readTab())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const goto = useCallback((t: string) => {
    window.location.hash = `#/${t}`
  }, [])
  return [tab, goto]
}

export function App() {
  const { phase, backend } = useApp()
  let body
  switch (phase) {
    case 'loading': body = <Loading />; break
    case 'unconfigured': body = <Unconfigured />; break
    case 'anon': body = <AuthScreen />; break
    case 'error': body = <ConnectError />; break
    case 'pending': body = <PendingApproval />; break
    default: body = <Shell />
  }
  return (
    <>
      {backend?.kind === 'mock' && phase === 'pending' && <DevBar />}
      {body}
      <Toasts />
    </>
  )
}

function DevBar() {
  const { backend, refresh } = useApp()
  const [users, setUsers] = useState<MockUser[]>([])
  const mock = backend as MockBackend
  useEffect(() => {
    void mock.dev.users().then(setUsers)
  }, [mock])
  return (
    <div className="dev-bar">
      <b>開発用モック</b>
      <span>端末(ユーザー)切替:</span>
      <select
        aria-label="ユーザー切替"
        onChange={(e) => void mock.dev.switchUser(e.target.value).then(() => refresh())}
        defaultValue=""
      >
        <option value="" disabled>選択</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}({u.role}{u.active ? '' : '・承認待ち'})</option>)}
      </select>
    </div>
  )
}

function Shell() {
  const { snapshot, conn, backend } = useApp()
  const [tab, goto] = useTab()
  const me = snapshot!.me!
  const day = snapshot!.day
  const orders = snapshot!.orders ?? []
  const pendingOrders = orders.filter((o) => o.status === 'paid' && !o.served_at).length
  const pendingStaff = me.role === 'admin' ? (snapshot!.staff ?? []).filter((s) => s.active === false).length : 0

  return (
    <div className="app">
      {backend?.kind === 'mock' && <DevBar />}
      <header className="hdr">
        <span className={`dot ${conn}`} role="status" aria-label={conn === 'online' ? 'オンライン' : conn === 'degraded' ? '同期が不安定' : 'オフライン'} />
        <div className="grow">
          <span className="title">屋台レジ</span>
          <span className="day">{day ? `営業中 ${dateJa(day.business_date)}` : '営業前'}</span>
        </div>
        <div className="me">{me.display_name}<small>{me.role === 'admin' ? '管理者' : 'スタッフ'}</small></div>
      </header>
      {conn === 'offline' && <div className="banner offline" role="alert">通信できません。会計・提供は送信されません(電波が戻ると自動で最新に更新します)</div>}
      {conn === 'degraded' && <div className="banner degraded" role="status">リアルタイム同期が切れています。自動で再接続中です(数秒ごとに最新を取得します)</div>}

      <main className="main">
        {tab === 'register' && <Register goto={goto} />}
        {tab === 'handover' && <Handover />}
        {tab === 'cash' && <Cash />}
        {tab === 'sales' && <Sales />}
        {tab === 'admin' && <Admin />}
      </main>

      <nav className="tabbar" aria-label="メニュー">
        {TABS.map((t) => (
          <button key={t.id} className="tab" aria-current={tab === t.id ? 'page' : undefined} onClick={() => goto(t.id)}>
            <Icon name={t.icon} />
            {t.label}
            {t.id === 'handover' && pendingOrders > 0 && <span className="count">{pendingOrders}</span>}
            {t.id === 'admin' && pendingStaff > 0 && <span className="count">{pendingStaff}</span>}
          </button>
        ))}
      </nav>
    </div>
  )
}
