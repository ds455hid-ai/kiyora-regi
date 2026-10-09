export type Category = 'food' | 'drink' | 'other'

export interface Profile {
  id: string | null
  display_name: string
  role: 'admin'
  active: boolean
}

export interface Product {
  id: string
  name: string
  price: number
  category: Category
  sort_order: number
  visible: boolean
  sold_out: boolean
}

export interface BusinessDay {
  id: string
  business_date: string
  status: 'open' | 'closed'
  opening_float: number
  next_order_no: number
  opened_at: string
  opened_by_name: string | null
  closed_at: string | null
  expected_cash: number | null
  counted_cash: number | null
  variance: number | null
}

export interface OrderItem {
  id: string
  order_id: string
  line_no: number
  product_id: string | null
  name: string
  unit_price: number
  qty: number
  served_qty: number
  last_served_by_name: string | null
  last_served_at: string | null
}

export interface Order {
  id: string
  business_day_id: string
  order_no: number
  staff_name: string
  total: number
  received: number
  change_given: number
  status: 'paid' | 'voided'
  created_at: string
  served_at: string | null
  voided_at: string | null
  voided_by_name: string | null
  void_reason: string | null
  items: OrderItem[]
}

export type CashKind = 'opening' | 'sale' | 'refund' | 'replenish' | 'collect'

export interface CashEvent {
  id: string
  kind: CashKind
  amount: number
  order_id: string | null
  staff_name: string | null
  note: string | null
  created_at: string
}

export interface ServeEvent {
  id: string
  order_id: string
  item_name: string
  delta: number
  staff_name: string
  created_at: string
}

export interface Snapshot {
  schema_version: number
  server_time?: string
  me: Profile | null
  products?: Product[]
  day?: BusinessDay | null
  balance?: number
  cash_totals?: Partial<Record<CashKind, number>>
  orders?: Order[]
  cash_events?: CashEvent[]
  serve_events?: ServeEvent[]
}

export interface SalesSummary {
  day_id: string | null
  sales_total: number
  order_count: number
  voided_count: number
  voided_total: number
  item_count: number
  by_product: { name: string; qty: number; amount: number }[]
  by_staff: { staff_name: string; order_count: number; amount: number }[]
}

export interface DayRow {
  id: string
  business_date: string
  status: 'open' | 'closed'
  opening_float: number
  expected_cash: number | null
  counted_cash: number | null
  variance: number | null
  closed_at: string | null
  close_note: string | null
  sales_total: number
  order_count: number
  voided_count: number
  balance: number
}

export interface AuditRow {
  id: number
  at: string
  staff_name: string | null
  action: string
  entity: string | null
  details: Record<string, unknown>
}

export interface ExportRow {
  business_date: string
  order_no: number
  created_at: string
  staff_name: string
  status: string
  line_no: number
  item_name: string
  unit_price: number
  qty: number
  line_total: number
  order_total: number
  received: number
  change_given: number
  served_at: string | null
  void_reason: string | null
}

export interface CartLine {
  productId: string
  qty: number
}
