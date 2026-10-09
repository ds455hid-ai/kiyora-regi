// 本物の Supabase に対する動作チェック(複数端末の同時操作・権限・リアルタイム同期)
//
//   node scripts/verify-supabase.mjs
//
// ログイン不要。2 台の端末(検証A / 検証B)のつもりで同時に操作します。
// ⚠ テスト用の営業日と会計(40件前後)を作ります。本番データがある状態では実行しません
//    (営業日がすでに存在すると中断)。終わったら supabase/maintenance/reset_test_data.sql で消します。
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
const pick = (k) => process.env[k] || (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
const URL_ = pick('VITE_SUPABASE_URL')
const KEY = pick('VITE_SUPABASE_ANON_KEY')
if (!URL_ || !KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が見つかりません(.env.production)')
  process.exit(1)
}

/** 端末ごとに担当者名ヘッダー(x-staff-name)を付けたクライアント */
const device = (name) =>
  createClient(URL_, KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        if (name) headers.set('x-staff-name', encodeURIComponent(name))
        return fetch(input, { ...init, headers })
      },
    },
  })

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`)
}
const rpc = async (c, fn, args = {}) => {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw Object.assign(new Error(error.message), { detail: error.details, code: error.code })
  return data
}
const settle = (ps) => Promise.allSettled(ps)

async function main() {
  const A = device('検証A')
  const B = device('検証B')
  const clients = [A, B]

  console.log('\n== 準備 ==')
  let snap = await rpc(A, 'app_snapshot')
  const days = await A.from('business_days').select('id')
  if ((days.data ?? []).length > 0 && !process.env.ALLOW_EXISTING) {
    throw new Error('すでに営業日のデータがあります(本番データを巻き込まないため中断)。テスト専用の状態で実行してください。')
  }
  if (!snap.day) {
    await rpc(A, 'open_business_day', { p_float: 10000, p_denoms: null, p_date: null })
    snap = await rpc(A, 'app_snapshot')
  }
  const product = (snap.products ?? []).find((p) => p.visible && !p.sold_out)
  const price = product.price
  const received = Math.max(price * 3, 1000)
  console.log(`  営業日 ${snap.day.business_date} / 商品「${product.name}」${price}円 / 担当名の記録: ${snap.me.display_name}`)
  check('担当者名がヘッダーから伝わる', (await rpc(B, 'app_snapshot')).me.display_name === '検証B')

  console.log('\n== 1. 2 台から同時に 20 件会計 → 注文番号の重複なし ==')
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
  check('担当者名が各端末の名前で記録される', okOrders.filter((o) => o.staff_name === '検証A').length === 10 && okOrders.filter((o) => o.staff_name === '検証B').length === 10)

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

  console.log('\n== 4. 返金・現金残高の整合 ==')
  const voidTarget = okOrders[2]
  const voids = await settle(Array.from({ length: 4 }, (_, i) => rpc(clients[i % 2], 'void_order', { p_order: voidTarget.id, p_reason: '検証' })))
  const voidVals = voids.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  check('同時に返金しても返金は 1 回だけ', voidVals.filter((v) => !v.already_voided).length === 1)
  const after = await rpc(A, 'app_snapshot')
  const paid = after.orders.filter((o) => o.status === 'paid').reduce((s, o) => s + o.total, 0)
  const ct = after.cash_totals
  // 返金済みの注文は paid に含まれないので、返金額をもう一度引かない
  check('残高 = 釣銭 + 有効な売上 + 補充 − 回収', after.balance === after.day.opening_float + paid + (ct.replenish ?? 0) + (ct.collect ?? 0), `残高 ${after.balance}`)
  check('現金売上 + 返金(マイナス) = 有効な売上', (ct.sale ?? 0) + (ct.refund ?? 0) === paid)
  check('別の端末でも同じ残高が見える', (await rpc(B, 'app_snapshot')).balance === after.balance)

  console.log('\n== 5. リアルタイム同期(端末Bが端末Aの会計を受信) ==')
  const got = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 10000)
    B.channel('verify')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, () => {
        clearTimeout(t)
        resolve(true)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await new Promise((r) => setTimeout(r, 1500))
          await rpc(A, 'create_order', { p_request_id: randomUUID(), p_items: [{ product_id: product.id, qty: 1 }], p_received: received })
        }
      })
  })
  check('別端末の会計がリアルタイムで届く', await got)
  await B.removeAllChannels()

  console.log('\n== 6. 直接の書き込み・認証テーブルへのアクセスは不可 ==')
  const direct = await B.from('orders').insert({ business_day_id: after.day.id, order_no: 9999, request_id: randomUUID(), staff_name: 'x', total: 1, received: 1, change_given: 0 })
  check('端末から注文テーブルへ直接書き込めない', !!direct.error)
  const upd = await B.from('products').update({ price: 1 }).eq('id', product.id).select()
  check('端末から商品テーブルを直接書き換えられない', !!upd.error || (upd.data ?? []).length === 0)
  const prof = await B.from('profiles').select('id')
  check('認証関連のテーブル(profiles)は読めない', !!prof.error)
  let staffFn = false
  try {
    await rpc(B, 'admin_update_staff', { p_user: randomUUID(), p_active: true, p_role: 'admin', p_display_name: null })
  } catch (e) {
    staffFn = /permission denied/i.test(e.message)
  }
  check('ログイン用のスタッフ管理関数は呼べない', staffFn)
  let internal = false
  try {
    await rpc(B, '_require_admin')
  } catch (e) {
    internal = /permission denied|Could not find/i.test(e.message)
  }
  check('内部ヘルパー関数は呼べない', internal)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${failed.length === 0 ? '✅ すべて合格' : `❌ ${failed.length} 件が不合格`}  (${results.length - failed.length}/${results.length})`)
  console.log('※ テスト会計が残っています。supabase/maintenance/reset_test_data.sql で消してください。')
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n✗ 中断:', e.message)
  process.exit(1)
})
