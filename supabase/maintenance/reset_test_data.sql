-- テスト会計・テスト営業日を全部消して、本番開始前の状態に戻す(商品とスタッフは残ります)。
-- Supabase の SQL Editor で実行します。実際の売上データも消えるので、本番営業の後は実行しないでください。
truncate table
  public.audit_log,
  public.serve_events,
  public.cash_events,
  public.order_items,
  public.orders,
  public.business_days
restart identity cascade;
