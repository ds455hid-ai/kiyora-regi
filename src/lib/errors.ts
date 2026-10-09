export class AppError extends Error {
  /** DB 側の raise exception のコード(例: no_open_day)または 'network' / 'unknown' */
  code: string
  detail?: string
  /** 通信そのものの失敗(結果が不明)。再送には同じ request_id を使うこと */
  network: boolean
  constructor(code: string, detail?: string, network = false) {
    super(code)
    this.code = code
    this.detail = detail
    this.network = network
  }
}

const MESSAGES: Record<string, string> = {
  forbidden: 'この操作を行う権限がありません',
  no_open_day: '営業が開始されていません。管理者が「営業開始」を行ってください',
  day_closed: 'この営業日はすでに終了しています',
  day_already_open: 'すでに営業中の日があります',
  day_exists: 'この日付の営業日はすでに作成されています',
  day_not_found: '営業日が見つかりません',
  day_not_closed: '営業中の日は再開できません',
  product_not_found: '商品が見つかりません',
  product_hidden: '非表示の商品が含まれています',
  product_sold_out: '売り切れの商品が含まれています',
  invalid_qty: '数量が正しくありません',
  invalid_items: '商品が選択されていません',
  invalid_total: '合計金額が正しくありません',
  invalid_received: 'お預かり金額が正しくありません',
  insufficient_received: 'お預かり金額が足りません',
  invalid_amount: '金額が正しくありません',
  invalid_denoms: '金種・枚数の入力が正しくありません',
  invalid_name: '名前が正しくありません(1〜40文字)',
  invalid_category: 'カテゴリが正しくありません',
  invalid_role: '権限の指定が正しくありません',
  invalid_kind: '操作の種類が正しくありません',
  insufficient_cash: '現金箱の残高が足りません',
  order_not_found: '注文が見つかりません',
  order_voided: 'この注文は取消(返金)済みです',
  item_not_found: '明細が見つかりません',
  staff_not_found: 'スタッフが見つかりません',
  last_admin: '最後の管理者は無効化・降格できません',
  request_id_required: '操作IDがありません。画面を再読み込みしてください',
  network: '通信できませんでした。電波の良い場所で再度お試しください',
}

export function errorMessage(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code === 'unserved_orders') return `未提供の注文が${e.detail ?? ''}件あります`
    if (e.code === 'product_sold_out' && e.detail) return `「${e.detail}」は売り切れです`
    if (e.code === 'product_hidden' && e.detail) return `「${e.detail}」は非表示になっています`
    if (e.code === 'insufficient_cash' && e.detail) return `現金箱の残高が足りません(必要額 ¥${Number(e.detail).toLocaleString('ja-JP')})`
    if (e.code === 'insufficient_received' && e.detail) return `お預かり金額が足りません(合計 ¥${Number(e.detail).toLocaleString('ja-JP')})`
    return MESSAGES[e.code] ?? `エラーが発生しました(${e.code})`
  }
  return e instanceof Error ? e.message : 'エラーが発生しました'
}
