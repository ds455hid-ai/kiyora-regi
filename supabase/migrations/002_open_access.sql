-- =====================================================================
-- kiyora-regi v2 : ログインなし(オープン)モード
--
-- 001_init.sql を実行したあとに、SQL Editor で 1 回だけ実行します。
--
-- 変更点
--   * メール/パスワードのログインを使わない。未ログイン(anon)のまま、
--     すべての画面・操作(会計/受け渡し/現金/返金/営業開始終了/商品変更/CSV)を使える。
--   * 会計などの「担当スタッフ名」は、端末が送る x-staff-name ヘッダー(パーセントエンコード)
--     から記録する(端末ごとに最初に名前を入れるだけ)。
--   * テーブルへの直接書き込みは引き続き不可。書き込みは RPC(トランザクション・冪等・行ロック)のみ。
--
-- ※ 公開URLを知っている人なら誰でも操作できる設計です(認証なし)。URL を広く共有しないでください。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. スタッフ名(リクエストヘッダー x-staff-name)
-- ---------------------------------------------------------------------

create or replace function public._urldecode(p text)
returns text language plpgsql immutable as $$
declare
  r bytea := ''::bytea;
  i integer := 1;
  n integer := coalesce(length(p), 0);
  c text;
begin
  while i <= n loop
    c := substr(p, i, 1);
    if c = '%' and i + 2 <= n and substr(p, i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' then
      r := r || decode(substr(p, i + 1, 2), 'hex');
      i := i + 3;
    else
      r := r || convert_to(c, 'UTF8');
      i := i + 1;
    end if;
  end loop;
  return convert_from(r, 'UTF8');
end $$;

-- 内部用: 端末から直接は呼べないようにする(関数は既定で PUBLIC に実行権限が付くため明示的に剥奪)
revoke all on function public._urldecode(text) from public, anon, authenticated;

create or replace function public._staff_name()
returns text language plpgsql stable as $$
declare
  h text;
  v text;
begin
  begin
    h := current_setting('request.headers', true);
    if h is not null and h <> '' then
      v := public._urldecode(h::json ->> 'x-staff-name');
    end if;
  exception when others then
    v := null;
  end;
  v := left(btrim(regexp_replace(coalesce(v, ''), '[[:cntrl:]]', '', 'g')), 30);
  return case when v = '' then '名無し' else v end;
end $$;

-- ---------------------------------------------------------------------
-- 2. 認証チェックを「常に許可 + スタッフ名のみ記録」に置き換え
--    (各 RPC の中身は変更なし。担当者の staff_id は NULL、名前だけが記録される)
-- ---------------------------------------------------------------------

create or replace function public._require_staff()
returns public.profiles language sql stable security definer set search_path = public as $$
  select row(null::uuid, public._staff_name(), 'admin'::text, true, now())::public.profiles;
$$;

create or replace function public._require_admin()
returns public.profiles language sql stable security definer set search_path = public as $$
  select row(null::uuid, public._staff_name(), 'admin'::text, true, now())::public.profiles;
$$;

create or replace function public.is_active_staff()
returns boolean language sql stable security definer set search_path = public as $$ select true $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$ select true $$;

-- ---------------------------------------------------------------------
-- 3. 読み取りポリシー: 未ログイン(anon)も全テーブルを読める(書き込みは不可のまま)
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['products', 'business_days', 'orders', 'order_items',
                           'serve_events', 'cash_events', 'audit_log'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_select', t);
  end loop;
end $$;

grant select on public.products, public.business_days, public.orders, public.order_items,
                public.serve_events, public.cash_events, public.audit_log to anon;

-- ---------------------------------------------------------------------
-- 4. 画面表示用の snapshot(ログイン情報なし版)
-- ---------------------------------------------------------------------

create or replace function public.app_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_day jsonb;
  v_day_id uuid;
begin
  select to_jsonb(d), d.id into v_day, v_day_id from public.business_days d where d.status = 'open' limit 1;

  return jsonb_build_object(
    'schema_version', 2,
    'server_time', now(),
    'me', jsonb_build_object('id', null, 'display_name', public._staff_name(), 'role', 'admin', 'active', true),
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort_order, p.created_at, p.id)
                            from public.products p), '[]'::jsonb),
    'day', v_day,
    'balance', coalesce((select sum(c.amount)::integer from public.cash_events c
                          where c.business_day_id = v_day_id), 0),
    'cash_totals', coalesce((select jsonb_object_agg(k.kind, k.s)
                               from (select c.kind, sum(c.amount)::integer as s
                                       from public.cash_events c
                                      where c.business_day_id = v_day_id group by c.kind) k), '{}'::jsonb),
    'orders', coalesce((select jsonb_agg(public._order_json(o) order by o.order_no)
                          from public.orders o where o.business_day_id = v_day_id), '[]'::jsonb),
    'cash_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc)
                               from (select * from public.cash_events
                                      where business_day_id = v_day_id
                                      order by created_at desc limit 300) e), '[]'::jsonb),
    'serve_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc)
                                from (select * from public.serve_events
                                       where business_day_id = v_day_id
                                       order by created_at desc limit 300) e), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------
-- 5. 実行権限: 業務 RPC を anon にも許可。スタッフ管理(ログイン用)は誰にも許可しない
-- ---------------------------------------------------------------------

grant execute on function public._staff_name() to anon, authenticated;
grant execute on function public.is_active_staff() to anon;
grant execute on function public.is_admin() to anon;
grant execute on function public.current_open_day() to anon;
grant execute on function public._order_json(public.orders) to anon;

grant execute on function public.open_business_day(integer, jsonb, date) to anon;
grant execute on function public.close_business_day(uuid, jsonb, text, boolean) to anon;
grant execute on function public.reopen_business_day(uuid) to anon;
grant execute on function public.create_order(uuid, jsonb, integer) to anon;
grant execute on function public.void_order(uuid, text) to anon;
grant execute on function public.serve_item(uuid, integer, integer) to anon;
grant execute on function public.serve_order(uuid) to anon;
grant execute on function public.unserve_order(uuid) to anon;
grant execute on function public.record_cash_event(uuid, text, integer, text) to anon;
grant execute on function public.upsert_product(uuid, text, integer, text, integer, boolean) to anon;
grant execute on function public.delete_product(uuid) to anon;
grant execute on function public.set_sold_out(uuid, boolean) to anon;
grant execute on function public.app_snapshot() to anon;
grant execute on function public.sales_summary(uuid) to anon;
grant execute on function public.sales_by_day() to anon;
grant execute on function public.day_detail(uuid) to anon;
grant execute on function public.export_rows(uuid) to anon;
grant execute on function public.list_audit(integer) to anon;

revoke execute on function public.admin_update_staff(uuid, boolean, text, text) from anon, authenticated;
