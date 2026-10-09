import type { Backend } from './backend'
import type {
  AuditRow, BusinessDay, CashEvent, Category, DayRow, ExportRow, Order, SalesSummary, Snapshot,
} from './types'

export type Rpc = Backend['rpc']

export interface ServeItemResult {
  ok: boolean
  reason?: 'conflict'
  changed?: boolean
  served_qty?: number
  served_by?: string | null
  order: Order
}

export interface ServeOrderResult {
  ok: boolean
  already_served: boolean
  served_by: string | null
  order: Order
}

/** 画面から使う RPC の型付きラッパー(実体は DB 側の関数) */
export function makeApi(rpc: Rpc) {
  return {
    snapshot: () => rpc<Snapshot>('app_snapshot'),

    createOrder: (requestId: string, items: { product_id: string; qty: number }[], received: number) =>
      rpc<{ duplicate: boolean; order: Order }>('create_order', {
        p_request_id: requestId, p_items: items, p_received: received,
      }),
    voidOrder: (orderId: string, reason: string | null) =>
      rpc<{ already_voided: boolean; order: Order }>('void_order', { p_order: orderId, p_reason: reason }),

    serveItem: (itemId: string, from: number, to: number) =>
      rpc<ServeItemResult>('serve_item', { p_item: itemId, p_from: from, p_to: to }),
    serveOrder: (orderId: string) => rpc<ServeOrderResult>('serve_order', { p_order: orderId }),
    unserveOrder: (orderId: string) => rpc<{ ok: boolean; order: Order }>('unserve_order', { p_order: orderId }),

    openDay: (denoms: Record<string, number> | null, amount: number | null, date: string | null = null) =>
      rpc('open_business_day', { p_float: amount, p_denoms: denoms, p_date: date }),
    closeDay: (dayId: string, denoms: Record<string, number>, note: string | null, force: boolean) =>
      rpc('close_business_day', { p_day: dayId, p_denoms: denoms, p_note: note, p_force: force }),
    reopenDay: (dayId: string) => rpc('reopen_business_day', { p_day: dayId }),

    recordCash: (requestId: string, kind: 'replenish' | 'collect', amount: number, note: string | null) =>
      rpc<{ duplicate: boolean; balance: number }>('record_cash_event', {
        p_request_id: requestId, p_kind: kind, p_amount: amount, p_note: note,
      }),

    upsertProduct: (p: {
      id: string | null; name: string; price: number; category: Category; sortOrder: number; visible: boolean
    }) =>
      rpc('upsert_product', {
        p_id: p.id, p_name: p.name, p_price: p.price, p_category: p.category,
        p_sort_order: p.sortOrder, p_visible: p.visible,
      }),
    deleteProduct: (id: string) => rpc('delete_product', { p_id: id }),
    setSoldOut: (id: string, soldOut: boolean) => rpc('set_sold_out', { p_product: id, p_sold_out: soldOut }),

    salesSummary: (dayId: string | null = null) => rpc<SalesSummary>('sales_summary', { p_day: dayId }),
    salesByDay: () => rpc<DayRow[]>('sales_by_day'),
    dayDetail: (dayId: string) =>
      rpc<{ day: BusinessDay | null; orders: Order[]; cash_events: CashEvent[] }>('day_detail', { p_day: dayId }),
    exportRows: (dayId: string | null) => rpc<ExportRow[]>('export_rows', { p_day: dayId }),
    listAudit: (limit = 200) => rpc<AuditRow[]>('list_audit', { p_limit: limit }),
  }
}

export type Api = ReturnType<typeof makeApi>

/** 副作用のない読み取り系(これらの後は再取得しない) */
export const READ_ONLY_RPCS = new Set([
  'app_snapshot', 'sales_summary', 'sales_by_day', 'day_detail', 'export_rows', 'list_audit',
])
