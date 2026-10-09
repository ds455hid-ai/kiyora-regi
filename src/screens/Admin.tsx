import { useEffect, useState } from 'react'
import { DayControl } from '../components/DayControl'
import { saveTextFile } from '../lib/csv'
import { APP_VERSION } from '../lib/env'
import { errorMessage } from '../lib/errors'
import { dateTimeJa, orderNo, yen } from '../lib/format'
import { readLegacyData, type LegacyData } from '../lib/legacy'
import type { AuditRow, Category, Product, StaffRow } from '../lib/types'
import { useApp } from '../store'

type Section = 'day' | 'products' | 'staff' | 'more'

const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
  { value: 'food', label: '食べ物' },
  { value: 'drink', label: 'ドリンク' },
  { value: 'other', label: 'その他' },
]

export function Admin() {
  const { snapshot } = useApp()
  const isAdmin = snapshot!.me!.role === 'admin'
  const pendingStaff = (snapshot!.staff ?? []).filter((s) => s.active === false).length
  const [section, setSection] = useState<Section>(isAdmin ? 'day' : 'products')

  return (
    <div className="screen">
      <div className="stack">
        {isAdmin ? (
          <div className="seg" role="group" aria-label="管理メニュー">
            <button aria-pressed={section === 'day'} onClick={() => setSection('day')}>営業</button>
            <button aria-pressed={section === 'products'} onClick={() => setSection('products')}>商品</button>
            <button aria-pressed={section === 'staff'} onClick={() => setSection('staff')}>
              スタッフ{pendingStaff > 0 ? ` (${pendingStaff})` : ''}
            </button>
            <button aria-pressed={section === 'more'} onClick={() => setSection('more')}>その他</button>
          </div>
        ) : (
          <div className="h2">売り切れ設定</div>
        )}

        {section === 'day' && isAdmin && <DayControl />}
        {section === 'products' && (isAdmin ? <ProductsSection /> : <SoldOutSection />)}
        {section === 'staff' && isAdmin && <StaffSection />}
        {(section === 'more' || !isAdmin) && <MoreSection isAdmin={isAdmin} />}
      </div>
    </div>
  )
}

/* ---------------- 売り切れ(一般スタッフも操作可) ---------------- */
function SoldOutSection() {
  const { snapshot, api, toast } = useApp()
  const products = (snapshot!.products ?? []).filter((p) => p.visible)
  const [busy, setBusy] = useState<string | null>(null)
  async function toggle(p: Product) {
    setBusy(p.id)
    try {
      await api.setSoldOut(p.id, !p.sold_out)
      toast(`${p.name}を${p.sold_out ? '販売再開' : '売り切れ'}にしました`, 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="card list">
      {products.map((p) => (
        <div className="li" key={p.id}>
          <div className="grow"><div style={{ fontWeight: 700 }}>{p.name}</div><div className="muted num">{yen(p.price)}</div></div>
          <button className={`btn sm ${p.sold_out ? 'danger' : ''}`} disabled={busy === p.id} onClick={() => void toggle(p)} aria-pressed={p.sold_out}>
            {p.sold_out ? '売り切れ中(再開する)' : '売り切れにする'}
          </button>
        </div>
      ))}
    </div>
  )
}

/* ---------------- 商品管理 ---------------- */
function ProductsSection() {
  const { snapshot, api, toast } = useApp()
  const products = snapshot!.products ?? []
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [category, setCategory] = useState<Category>('drink')
  const [busy, setBusy] = useState(false)

  async function create() {
    if (!name.trim() || price === '' || busy) return
    setBusy(true)
    try {
      const sort = Math.max(0, ...products.map((p) => p.sort_order)) + 10
      await api.upsertProduct({ id: null, name: name.trim(), price: Number(price), category, sortOrder: sort, visible: true })
      toast(`「${name.trim()}」を追加しました`, 'ok')
      setName('')
      setPrice('')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>商品を追加</h3>
        <label className="field">商品名<input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="例: 生ビール" /></label>
        <div className="row">
          <label className="field grow">価格(税込・円)<input className="input num" inputMode="numeric" pattern="[0-9]*" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))} /></label>
          <label className="field grow">種類
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <button className="btn primary block" disabled={busy || !name.trim() || price === ''} onClick={() => void create()}>追加する</button>
      </div>
      {products.map((p) => (
        <ProductRow key={`${p.id}:${p.name}:${p.price}:${p.category}:${p.visible}:${p.sort_order}`} product={p} />
      ))}
    </>
  )
}

function ProductRow({ product: p }: { product: Product }) {
  const { api, toast } = useApp()
  const [name, setName] = useState(p.name)
  const [price, setPrice] = useState(String(p.price))
  const [category, setCategory] = useState<Category>(p.category)
  const [sort, setSort] = useState(String(p.sort_order))
  const [visible, setVisible] = useState(p.visible)
  const [busy, setBusy] = useState(false)

  const dirty = name !== p.name || Number(price) !== p.price || category !== p.category || Number(sort) !== p.sort_order || visible !== p.visible

  async function save() {
    setBusy(true)
    try {
      await api.upsertProduct({ id: p.id, name: name.trim(), price: Number(price), category, sortOrder: Number(sort), visible })
      toast('保存しました(過去の注文の価格は変わりません)', 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  async function toggleSoldOut() {
    try {
      await api.setSoldOut(p.id, !p.sold_out)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }
  async function remove() {
    if (!window.confirm(`「${p.name}」を削除します。過去の注文履歴は残ります。\n(一時的に隠したいだけなら「表示する」をオフにしてください)`)) return
    try {
      await api.deleteProduct(p.id)
      toast('削除しました', 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <div className="card stack" style={{ opacity: p.visible ? 1 : 0.75 }}>
      <div className="row">
        <label className="field grow">商品名<input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field" style={{ width: 120 }}>価格(円)<input className="input num" inputMode="numeric" pattern="[0-9]*" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))} /></label>
      </div>
      <div className="row">
        <label className="field grow">種類
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="field" style={{ width: 96 }}>並び順<input className="input num" inputMode="numeric" pattern="[0-9]*" value={sort} onChange={(e) => setSort(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))} /></label>
      </div>
      <div className="row wrap">
        <label className="row" style={{ gap: 6, fontWeight: 700 }}>
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} style={{ width: 22, height: 22 }} /> レジに表示する
        </label>
        <span className="grow" />
        <button className={`btn sm ${p.sold_out ? 'danger' : ''}`} onClick={() => void toggleSoldOut()} aria-pressed={p.sold_out}>{p.sold_out ? '売り切れ中→再開' : '売り切れにする'}</button>
      </div>
      <div className="row">
        <button className="btn primary grow" disabled={!dirty || busy || !name.trim() || price === ''} onClick={() => void save()}>{dirty ? '変更を保存' : '保存済み'}</button>
        <button className="btn sm danger" onClick={() => void remove()}>削除</button>
      </div>
    </div>
  )
}

/* ---------------- スタッフ管理 ---------------- */
function StaffSection() {
  const { snapshot, api, toast } = useApp()
  const meId = snapshot!.me!.id
  const staff = [...(snapshot!.staff ?? [])].sort((a, b) => Number(a.active) - Number(b.active) || (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  const [busy, setBusy] = useState<string | null>(null)

  async function update(s: StaffRow, patch: { active?: boolean; role?: 'admin' | 'staff'; name?: string }, okText: string) {
    setBusy(s.id)
    try {
      await api.updateStaff(s.id, patch.active ?? !!s.active, patch.role ?? s.role ?? 'staff', patch.name ?? null)
      toast(okText, 'ok')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="stack">
      <p className="hint" style={{ margin: 0 }}>
        スタッフはログイン画面の「新規登録」から自分で登録します。ここで「承認」すると使えるようになります。
        全員の登録が終わったら、Supabase の Authentication 設定で新規サインアップを OFF にすると安全です。
      </p>
      {staff.map((s) => (
        <div className="card stack" key={s.id}>
          <div className="row">
            <div className="grow">
              <div style={{ fontWeight: 900, fontSize: '1.05rem' }}>{s.display_name}{s.id === meId ? '(あなた)' : ''}</div>
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                {s.active ? <span className="chip good">有効</span> : <span className="chip warn">承認待ち/無効</span>}
                <span className="chip accent">{s.role === 'admin' ? '管理者' : 'スタッフ'}</span>
              </div>
            </div>
          </div>
          <div className="row wrap">
            {!s.active ? (
              <button className="btn primary grow" disabled={busy === s.id} onClick={() => void update(s, { active: true }, `${s.display_name}さんを承認しました`)}>承認する</button>
            ) : (
              <button className="btn grow" disabled={busy === s.id} onClick={() => void update(s, { active: false }, `${s.display_name}さんを無効にしました`)}>無効にする</button>
            )}
            <button className="btn grow" disabled={busy === s.id}
              onClick={() => void update(s, { role: s.role === 'admin' ? 'staff' : 'admin' }, s.role === 'admin' ? 'スタッフに変更しました' : '管理者に変更しました')}>
              {s.role === 'admin' ? 'スタッフにする' : '管理者にする'}
            </button>
            <button className="btn grow" disabled={busy === s.id}
              onClick={() => {
                const n = window.prompt('表示名を入力してください(過去の会計記録の名前は変わりません)', s.display_name)
                if (n && n.trim()) void update(s, { name: n.trim() }, '名前を変更しました')
              }}>名前を変更</button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------- その他: 操作履歴 / 旧データ / アカウント ---------------- */
const ACTION_LABEL: Record<string, string> = {
  open_day: '営業開始', close_day: 'レジ締め', reopen_day: '営業再開', create_order: '会計', void_order: '会計取消',
  cash_replenish: '現金補充', cash_collect: '現金回収', product_create: '商品追加', product_update: '商品変更',
  product_delete: '商品削除', product_sold_out: '売り切れ切替', staff_update: 'スタッフ変更',
}

function auditDetail(a: AuditRow): string {
  const d = a.details as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? yen(v) : '')
  switch (a.action) {
    case 'create_order': return `No.${orderNo(Number(d.order_no))} ${num(d.total)}`
    case 'void_order': return `No.${orderNo(Number(d.order_no))} ${num(d.total)} ${d.reason ? `(${String(d.reason)})` : ''}`
    case 'cash_replenish':
    case 'cash_collect': return `${num(d.amount)} ${d.note ? String(d.note) : ''}`
    case 'open_day': return `釣銭 ${num(d.opening_float)}`
    case 'close_day': return `理論 ${num(d.expected)} / 実際 ${num(d.counted)} / 過不足 ${String(d.variance)}`
    case 'product_create': return `${String(d.name)} ${num(d.price)}`
    case 'product_delete': return `${String(d.name)}`
    case 'product_sold_out': return `${String(d.name)} → ${d.sold_out ? '売り切れ' : '販売中'}`
    case 'product_update': {
      const b = d.before as Record<string, unknown> | undefined
      const f = d.after as Record<string, unknown> | undefined
      return b && f ? `${String(b.name)} ${num(b.price)} → ${String(f.name)} ${num(f.price)}` : ''
    }
    default: return ''
  }
}

function MoreSection({ isAdmin }: { isAdmin: boolean }) {
  const { snapshot, api, backend, signOut, toast } = useApp()
  const me = snapshot!.me!
  const [audit, setAudit] = useState<AuditRow[] | null>(null)
  const [legacy, setLegacy] = useState<LegacyData | null>(null)

  useEffect(() => {
    setLegacy(readLegacyData())
  }, [])

  async function loadAudit() {
    try {
      setAudit(await api.listAudit(200))
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async function exportLegacy() {
    if (!legacy) return
    await saveTextFile(`kiyora-regi-v1-backup-${new Date().toISOString().slice(0, 10)}.json`, legacy.json, 'application/json')
  }

  return (
    <>
      {isAdmin && (
        <div className="card stack">
          <div className="row between"><h3 style={{ margin: 0 }}>操作履歴(監査ログ)</h3><button className="btn sm" onClick={() => void loadAudit()}>{audit ? '更新' : '読み込む'}</button></div>
          {audit && (
            <div className="list" style={{ maxHeight: 360, overflowY: 'auto' }}>
              {audit.length === 0 && <div className="muted">履歴はありません</div>}
              {audit.map((a) => (
                <div className="li" key={a.id} style={{ alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{ACTION_LABEL[a.action] ?? a.action} <span className="muted" style={{ fontWeight: 500 }}>{a.staff_name}</span></div>
                    <div className="muted" style={{ fontSize: '0.78rem' }}>{auditDetail(a)}</div>
                  </div>
                  <span className="num muted" style={{ fontSize: '0.75rem' }}>{dateTimeJa(a.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>旧レジ(v1)のデータ</h3>
          {legacy && legacy.keys.length > 0 ? (
            <>
              <p style={{ margin: 0 }}>この端末のブラウザに旧レジの記録(取引 {legacy.historyCount} 件)が残っています。削除はしていません。</p>
              <button className="btn block" onClick={() => void exportLegacy()}>旧データをファイルに書き出す(JSON)</button>
              <button className="btn block" onClick={() => void navigator.clipboard?.writeText(legacy.json).then(() => toast('クリップボードにコピーしました', 'ok'))}>旧データをコピー</button>
            </>
          ) : (
            <p className="hint" style={{ margin: 0 }}>この端末には旧レジのデータはありません。</p>
          )}
          <a className="btn block" style={{ textAlign: 'center', textDecoration: 'none' }} href={`${import.meta.env.BASE_URL}legacy/index.html`}>旧レジを開く</a>
        </div>
      )}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>アカウント</h3>
        <div className="kv"><span>名前</span><span className="v">{me.display_name}</span></div>
        <div className="kv"><span>権限</span><span className="v">{me.role === 'admin' ? '管理者' : 'スタッフ'}</span></div>
        <div className="kv"><span>バージョン</span><span className="v">v{APP_VERSION}</span></div>
        <div className="kv"><span>接続先</span><span className="v">{backend?.kind === 'mock' ? '開発用モック' : 'Supabase'}</span></div>
        <button className="btn danger block" onClick={() => void signOut()}>ログアウト</button>
      </div>
    </>
  )
}
