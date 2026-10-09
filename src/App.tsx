import { useCallback, useEffect, useState } from 'react'
import { Icon } from './components/Icon'
import { Sheet } from './components/Sheet'
import { Toasts } from './components/Toasts'
import { dateJa } from './lib/format'
import { setStaffName } from './lib/staff'
import { Admin } from './screens/Admin'
import { Cash } from './screens/Cash'
import { Handover } from './screens/Handover'
import { NameForm, NameScreen } from './screens/NameScreen'
import { Register } from './screens/Register'
import { Sales } from './screens/Sales'
import { ConnectError, Loading, Unconfigured } from './screens/StatusScreens'
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
  const { phase } = useApp()
  let body
  switch (phase) {
    case 'loading': body = <Loading />; break
    case 'unconfigured': body = <Unconfigured />; break
    case 'needname': body = <NameScreen />; break
    case 'error': body = <ConnectError />; break
    default: body = <Shell />
  }
  return (
    <>
      {body}
      <Toasts />
    </>
  )
}

/** 開発用モックのときだけ表示: 別の端末のつもりで名前を切り替える */
function DevBar() {
  return (
    <div className="dev-bar">
      <b>開発用モック</b>
      <span>端末の名前:</span>
      {['店長', 'アリス', 'ボブ'].map((n) => (
        <button key={n} className="btn sm" style={{ minHeight: 26, padding: '2px 8px' }} onClick={() => setStaffName(n)}>{n}</button>
      ))}
    </div>
  )
}

function Shell() {
  const { snapshot, conn, backend, staffName } = useApp()
  const [tab, goto] = useTab()
  const [editName, setEditName] = useState(false)
  const day = snapshot!.day
  const orders = snapshot!.orders ?? []
  const pendingOrders = orders.filter((o) => o.status === 'paid' && !o.served_at).length

  return (
    <div className="app">
      {backend?.kind === 'mock' && <DevBar />}
      <header className="hdr">
        <span className={`dot ${conn}`} role="status" aria-label={conn === 'online' ? 'オンライン' : conn === 'degraded' ? '同期が不安定' : 'オフライン'} />
        <div className="grow">
          <span className="title">屋台レジ</span>
          <span className="day">{day ? `営業中 ${dateJa(day.business_date)}` : '営業前'}</span>
        </div>
        <button className="me" onClick={() => setEditName(true)} aria-label="名前を変更">
          {staffName}
          <small>名前を変更</small>
        </button>
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
          </button>
        ))}
      </nav>

      {editName && (
        <Sheet title="名前を変更" onClose={() => setEditName(false)}>
          <NameForm initial={staffName} submitLabel="この名前にする" onDone={() => setEditName(false)} />
        </Sheet>
      )}
    </div>
  )
}
