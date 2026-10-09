// 本物の Supabase に対する動作チェック(複数端末の同時操作・権限・リアルタイム同期)
//
//   node scripts/verify-supabase.mjs
//
// 事前に: ① docs/SETUP.md の手順で Supabase を設定 ② アプリで管理者を登録して「営業開始」
//         ③ スタッフ用のテストアカウントを 1 つ登録し、管理者が承認しておく
// 実行するとテスト会計(40件前後)が作られます。終わったら supabase/maintenance/reset_test_data.sql で消してください。
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import readline from 'node:readline'

const env = readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
const pick = (k) => process.env[k] || (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
const URL_ = pick('VITE_SUPABASE_URL')
const KEY = pick('VITE_SUPABASE_ANON_KEY')
if (!URL_ || !KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が見つかりません(.env.production)')
  process.exit(1)
}

function ask(q, hidden = false) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(q)) process.stdout.write(s)
        else process.stdout.write('*')
      }
    }
    rl.question(q, (a) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      res(a.trim())
    })
  })
}

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`)
}

async function login(label) {
  const email = process.env[`${label}_EMAIL`] || (await ask(`${label === 'ADMIN' ? '管理者' : 'スタッフ'}のメールアドレス: `))
  const password = process.env[`${label}_PASSWORD`] || (await ask('パスワード: ', true))
  const client = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`${label} ログイン失敗: ${error.message}`)
  return client
}

const rpc = async (c, fn, args = {}) => {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw Object.assign(new Error(error.message), { detail: error.details, code: error.code })
  return data
}
const settle = (ps) => Promise.allSettled(ps)

async function main() {
  console.log('\n== ログイン ==')
  const admin = await login('ADMIN')
  const staff = await login('STAFF')

  const snap = await rpc(admin, 'app_snapshot')
  if (!snap.day) throw new Error('営業中の日がありません。先にアプリの「管理 → 営業」で営業開始してください。')
  const product = (snap.products ?? []).find((p) => p.visible && !p.sold_out)
  if (!product) throw new Error('販売できる商品がありません')
  const price = product.price
  const received = Math.max(price * 3, 1000)
  const before = snap.orders.length
  console.log(`  営業日 ${snap.day.business_date} / 商品「${product.name}」${price}円 / 既存の注文 ${before} 件`)

  console.log('\n== 1. 2 台から同時に 20 件会計 → 注文番号の重複なし ==')
  const clients = [admin, staff]
  const orders = await settle(
    Array.from({ length: 20 }, (_, i) =>
      rpc(clients[i % 2], 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: product.id, qty: 1 }], p_received: received }),
    ),
  )
  const okOrders = orders.filter((r) => r.status === 'fulfilled').map((r) => r.value.order)
  check('20 件すべて成功', okOrders.length === 20, `${okOrders.length}/20`)
  const nos = okOrders.map((o) => o.order_no).sort((a, b) => a - b)
  check('注文番号が重複していない', new Set(nos).size === nos.length)
  check('注文番号が連続している', nos.every((n, i) => i === 0 || n === nos[i - 1] + 1), `${nos[0]}〜${nos.at(-1)}`)

  console.log('\n== 2. 通信断の再送(同じ会計IDを 8 並列) → 1 件だけ登録 ==')
  const req = randomUUID()
  const dup = await settle(
    Array.from({ length: 8 }, (_, i) => rpc(clients[i % 2], 'create_order', { p_request_id: req, p_items: [{ product_id: product.id, qty: 2 }], p_received: received })),
  )
  const dupVals = dup.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  check('8 件すべて応答あり', dupVals.length === 8)
  check('新規登録は 1 件だけ', dupVals.filter((v) => !v.duplicate).length === 1)
  check('全員が同じ注文番号を受け取る', new Set(dupVals.map((v) => v.order.order_no)).size === 1)

  console.log('\n== 3. 受け渡し: 同じ注文を同時に「提供完了」 → 二重提供なし ==')
  const target = okOrders[0]
  const serves = await settle(Array.from({ length: 6 }, (_, i) => rpc(clients[i % 2], 'serve_order', { p_order: target.id })))
  const sv = serves.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  check('提供が実際に行われたのは 1 回だけ', sv.filter((v) => !v.already_served).length === 1)
  const target2 = okOrders[1]
  const cas = await settle(Array.from({ length: 6 }, (_, i) => rpc(clients[i % 2], 'serve_item', { p_item: target2.items[0].id, p_from: 0, p_to: 1 })))
  const casVals = cas.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  check('品目の同時更新は 1 回だけ成功し、残りは conflict', casVals.filter((v) => v.ok).length === 1 && casVals.filter((v) => v.reason === 'conflict').length === 5)

  console.log('\n== 4. 現金残高の整合 ==')
  const after = await rpc(admin, 'app_snapshot')
  const paid = after.orders.filter((o) => o.status === 'paid').reduce((s, o) => s + o.total, 0)
  const col = -(after.cash_totals.collect ?? 0)
  const rep = after.cash_totals.replenish ?? 0
  const refund = -(after.cash_totals.refund ?? 0)
  check('残高 = 釣銭 + 売上 − 返金 + 補充 − 回収', after.balance === after.day.opening_float + paid - refund + rep - col, `残高 ${after.balance}`)
  check('スタッフ端末でも同じ残高が見える', (await rpc(staff, 'app_snapshot')).balance === after.balance)

  console.log('\n== 5. リアルタイム同期(スタッフ端末が管理者の会計を受信) ==')
  const got = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000)
    staff
      .channel('verify')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, () => {
        clearTimeout(t)
        resolve(true)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await new Promise((r) => setTimeout(r, 1500))
          await rpc(admin, 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: product.id, qty: 1 }], p_received: received })
        }
      })
  })
  check('別端末の会計がリアルタイムで届く', await got)
  await staff.removeAllChannels()

  console.log('\n== 6. 権限(RLS / RPC) ==')
  const denied = async (c, fn, args) => {
    try {
      await rpc(c, fn, args)
      return false
    } catch (e) {
      return /forbidden|permission denied/i.test(e.message)
    }
  }
  check('スタッフは営業開始・返金・商品変更ができない', (await denied(staff, 'open_business_day', { p_float: 1, p_denoms: null, p_date: null })) &&
    (await denied(staff, 'void_order', { p_order: target.id, p_reason: null })) &&
    (await denied(staff, 'upsert_product', { p_id: product.id, p_name: 'x', p_price: 1, p_category: 'food', p_sort_order: 0, p_visible: true })))
  const direct = await staff.from('orders').insert({ business_day_id: after.day.id, order_no: 9999, request_id: randomUUID(), staff_name: 'x', total: 1, received: 1, change_given: 0 })
  check('端末から注文テーブルへ直接書き込めない', !!direct.error)
  const anon = createClient(URL_, KEY, { auth: { persistSession: false } })
  const a1 = await anon.from('products').select('id')
  check('未ログインでは商品も読めない', !!a1.error || (a1.data ?? []).length === 0)
  const a2 = await anon.rpc('app_snapshot')
  check('未ログインではRPCを呼べない', !!a2.error)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${failed.length === 0 ? '✅ すべて合格' : `❌ ${failed.length} 件が不合格`}  (${results.length - failed.length}/${results.length})`)
  console.log('※ テスト会計が残っています。本番開始前に supabase/maintenance/reset_test_data.sql を実行して消してください。')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n✗ 中断:', e.message)
  process.exit(1)
})
