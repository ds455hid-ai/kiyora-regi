-- =====================================================================
-- kiyora-regi v2 : 屋台POS 初期スキーマ
--
-- Supabase ダッシュボードの「SQL Editor」に全文を貼り付けて 1 回だけ実行します。
--
-- 設計方針
--   * テーブルは端末(ブラウザ)から「読み取り専用」。書き込みはすべて下の RPC
--     (security definer 関数) 経由で、権限チェック・金額計算・連番発行・冪等性を
--     データベース側のトランザクションで保証します。
--   * RLS は有効化済み。ログイン済みかつ承認済みスタッフだけが読み取れます。
--   * 秘密鍵(service_role)はブラウザに置きません。ブラウザは anon(publishable)キー
--     のみを使います。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. テーブル
-- ---------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 30),
  role text not null default 'staff' check (role in ('admin', 'staff')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  price integer not null check (price >= 0 and price <= 1000000),
  category text not null default 'food' check (category in ('food', 'drink', 'other')),
  sort_order integer not null default 0,
  visible boolean not null default true,
  sold_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.business_days (
  id uuid primary key default gen_random_uuid(),
  business_date date not null unique,
  status text not null default 'open' check (status in ('open', 'closed')),
  opening_float integer not null check (opening_float >= 0),
  opening_denoms jsonb,
  next_order_no integer not null default 1 check (next_order_no >= 1),
  opened_at timestamptz not null default now(),
  opened_by uuid references public.profiles (id) on delete set null,
  opened_by_name text,
  closed_at timestamptz,
  closed_by uuid references public.profiles (id) on delete set null,
  closed_by_name text,
  expected_cash integer,
  counted_cash integer,
  variance integer,
  closing_denoms jsonb,
  close_note text
);
-- 営業中の日は常に 1 つだけ
create unique index business_days_one_open on public.business_days ((true)) where status = 'open';

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_day_id uuid not null references public.business_days (id),
  order_no integer not null check (order_no >= 1),
  request_id uuid not null unique,                 -- 冪等キー(二重登録防止)
  staff_id uuid references public.profiles (id) on delete set null,
  staff_name text not null,
  total integer not null check (total > 0),
  received integer not null,
  change_given integer not null,
  status text not null default 'paid' check (status in ('paid', 'voided')),
  created_at timestamptz not null default now(),
  served_at timestamptz,                           -- 全品提供済みになった時刻
  voided_at timestamptz,
  voided_by uuid references public.profiles (id) on delete set null,
  voided_by_name text,
  void_reason text,
  constraint orders_received_ok check (received >= total and change_given = received - total),
  constraint orders_day_no_unique unique (business_day_id, order_no)   -- 注文番号の重複防止
);
create index orders_day_created on public.orders (business_day_id, created_at);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  business_day_id uuid not null references public.business_days (id),
  line_no integer not null,
  product_id uuid references public.products (id) on delete set null,
  name text not null,                              -- 注文時点の商品名(スナップショット)
  unit_price integer not null check (unit_price >= 0),  -- 注文時点の単価(スナップショット)
  qty integer not null check (qty between 1 and 99),
  served_qty integer not null default 0,
  last_served_by_name text,
  last_served_at timestamptz,
  constraint order_items_served_ok check (served_qty between 0 and qty)
);
create index order_items_order on public.order_items (order_id);
create index order_items_day on public.order_items (business_day_id);

create table public.serve_events (
  id uuid primary key default gen_random_uuid(),
  business_day_id uuid not null references public.business_days (id),
  order_id uuid not null references public.orders (id) on delete cascade,
  order_item_id uuid references public.order_items (id) on delete set null,
  item_name text not null,
  delta integer not null check (delta <> 0),       -- 提供: +n / 取り消し: -n
  staff_id uuid references public.profiles (id) on delete set null,
  staff_name text not null,
  created_at timestamptz not null default now()
);
create index serve_events_day_created on public.serve_events (business_day_id, created_at);

create table public.cash_events (
  id uuid primary key default gen_random_uuid(),
  business_day_id uuid not null references public.business_days (id),
  kind text not null check (kind in ('opening', 'sale', 'refund', 'replenish', 'collect')),
  amount integer not null,                         -- 現金箱への増減(符号付き)
  order_id uuid references public.orders (id) on delete set null,
  staff_id uuid references public.profiles (id) on delete set null,
  staff_name text,
  note text,
  request_id uuid unique,
  created_at timestamptz not null default now(),
  constraint cash_events_sign check (
    (kind in ('opening', 'sale', 'replenish') and amount >= 0)
    or (kind in ('refund', 'collect') and amount <= 0)
  )
);
create index cash_events_day_created on public.cash_events (business_day_id, created_at);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  staff_id uuid,
  staff_name text,
  action text not null,
  entity text,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb
);
create index audit_log_at on public.audit_log (at desc);

-- ---------------------------------------------------------------------
-- 2. 権限ヘルパー(RLS ポリシーと RPC から利用)
-- ---------------------------------------------------------------------

create or replace function public.is_active_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.active from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.active and p.role = 'admin' from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.current_open_day()
returns uuid language sql stable security definer set search_path = public as $$
  select d.id from public.business_days d where d.status = 'open' limit 1;
$$;

-- ---------------------------------------------------------------------
-- 3. RLS(読み取りのみ許可。書き込みポリシーは作らない = 端末から直接書けない)
-- ---------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.business_days enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.serve_events enable row level security;
alter table public.cash_events enable row level security;
alter table public.audit_log enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or (select public.is_active_staff()));

create policy products_select on public.products for select to authenticated
  using ((select public.is_active_staff()));

create policy business_days_select on public.business_days for select to authenticated
  using ((select public.is_active_staff()) and ((select public.is_admin()) or status = 'open'));

create policy orders_select on public.orders for select to authenticated
  using ((select public.is_active_staff())
         and ((select public.is_admin()) or business_day_id = (select public.current_open_day())));

create policy order_items_select on public.order_items for select to authenticated
  using ((select public.is_active_staff())
         and ((select public.is_admin()) or business_day_id = (select public.current_open_day())));

create policy serve_events_select on public.serve_events for select to authenticated
  using ((select public.is_active_staff())
         and ((select public.is_admin()) or business_day_id = (select public.current_open_day())));

create policy cash_events_select on public.cash_events for select to authenticated
  using ((select public.is_active_staff())
         and ((select public.is_admin()) or business_day_id = (select public.current_open_day())));

create policy audit_log_select on public.audit_log for select to authenticated
  using ((select public.is_admin()));

-- 直接の書き込み権限を剥奪(RLS に加えた二重の防御)
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------
-- 4. 新規登録 → プロフィール自動作成
--    最初に登録した 1 人だけが管理者(承認済み)になる。以降は「承認待ち」。
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_first boolean;
begin
  perform pg_advisory_xact_lock(7321001);
  v_name := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '');
  if v_name is null then
    v_name := split_part(coalesce(new.email, 'staff'), '@', 1);
  end if;
  v_name := left(btrim(v_name), 30);
  if v_name = '' then v_name := 'staff'; end if;

  v_first := not exists (select 1 from public.profiles where role = 'admin' and active);

  insert into public.profiles (id, display_name, role, active)
  values (new.id, v_name, case when v_first then 'admin' else 'staff' end, v_first);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 5. 内部ヘルパー(端末からは呼べない)
-- ---------------------------------------------------------------------

create or replace function public._require_staff()
returns public.profiles language plpgsql security definer set search_path = public as $$
declare v_me public.profiles;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if not found or not v_me.active then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_me;
end $$;

create or replace function public._require_admin()
returns public.profiles language plpgsql security definer set search_path = public as $$
declare v_me public.profiles;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if not found or not v_me.active or v_me.role <> 'admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_me;
end $$;

create or replace function public._audit(
  p_staff public.profiles, p_action text, p_entity text, p_entity_id uuid, p_details jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (staff_id, staff_name, action, entity, entity_id, details)
  values (p_staff.id, p_staff.display_name, p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function public._drawer_balance(p_day uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)::integer from public.cash_events where business_day_id = p_day;
$$;

-- 注文 + 明細を JSON にする(security invoker: 呼び出し側の RLS が効く)
create or replace function public._order_json(o public.orders)
returns jsonb language sql stable security invoker set search_path = public as $$
  select to_jsonb(o) || jsonb_build_object(
    'items',
    coalesce((select jsonb_agg(to_jsonb(i) order by i.line_no)
              from public.order_items i where i.order_id = o.id), '[]'::jsonb)
  );
$$;

create or replace function public._order_json_by_id(p_order uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select public._order_json(o) from public.orders o where o.id = p_order;
$$;

-- 全品提供済みなら served_at を立て、そうでなければ外す
create or replace function public._refresh_order_served(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.orders o
     set served_at = case
           when exists (select 1 from public.order_items i where i.order_id = o.id and i.served_qty < i.qty)
             then null
           else coalesce(o.served_at, now())
         end
   where o.id = p_order;
end $$;

-- ロック順序は全 RPC で「営業日の行 → 注文 → 明細」に統一する(デッドロック防止)。
-- 提供系は営業日の行を FOR SHARE で取る(提供どうしは並列、会計/返金/締めとは直列)。
create or replace function public._lock_day_shared(p_day uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.business_days where id = p_day for share;
end $$;

-- 金種(許可する額面)
create or replace function public._denoms_total(p_denoms jsonb)
returns integer language plpgsql immutable as $$
declare
  r record;
  v_total bigint := 0;
begin
  if p_denoms is null then return 0; end if;
  if jsonb_typeof(p_denoms) <> 'object' then raise exception 'invalid_denoms'; end if;
  for r in select key, value from jsonb_each_text(p_denoms) loop
    if r.key not in ('10000', '5000', '2000', '1000', '500', '100', '50', '10', '5', '1') then
      raise exception 'invalid_denoms';
    end if;
    if r.value !~ '^[0-9]{1,6}$' then
      raise exception 'invalid_denoms';
    end if;
    v_total := v_total + r.key::bigint * r.value::bigint;
  end loop;
  if v_total > 100000000 then raise exception 'invalid_denoms'; end if;
  return v_total::integer;
end $$;

-- ---------------------------------------------------------------------
-- 6. RPC: 営業日
-- ---------------------------------------------------------------------

create or replace function public.open_business_day(
  p_float integer, p_denoms jsonb default null, p_date date default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_date date := coalesce(p_date, (now() at time zone 'Asia/Tokyo')::date);
  v_float integer := p_float;
  v_day public.business_days;
begin
  v_me := public._require_admin();
  if p_denoms is not null then
    v_float := public._denoms_total(p_denoms);
  end if;
  if v_float is null or v_float < 0 or v_float > 1000000 then
    raise exception 'invalid_amount';
  end if;
  if exists (select 1 from public.business_days where status = 'open') then
    raise exception 'day_already_open';
  end if;
  if exists (select 1 from public.business_days where business_date = v_date) then
    raise exception 'day_exists';
  end if;

  insert into public.business_days (business_date, opening_float, opening_denoms, opened_by, opened_by_name)
  values (v_date, v_float, p_denoms, v_me.id, v_me.display_name)
  returning * into v_day;

  insert into public.cash_events (business_day_id, kind, amount, staff_id, staff_name, note)
  values (v_day.id, 'opening', v_float, v_me.id, v_me.display_name, '営業開始 釣銭');

  perform public._audit(v_me, 'open_day', 'business_day', v_day.id,
    jsonb_build_object('date', v_date, 'opening_float', v_float));
  return to_jsonb(v_day);
end $$;

create or replace function public.close_business_day(
  p_day uuid, p_denoms jsonb, p_note text default null, p_force boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_day public.business_days;
  v_expected integer;
  v_counted integer;
  v_unserved integer;
begin
  v_me := public._require_admin();
  select * into v_day from public.business_days where id = p_day for update;
  if not found then raise exception 'day_not_found'; end if;
  if v_day.status <> 'open' then raise exception 'day_closed'; end if;

  select count(*) into v_unserved
    from public.orders o
   where o.business_day_id = p_day and o.status = 'paid' and o.served_at is null;
  if v_unserved > 0 and not coalesce(p_force, false) then
    raise exception 'unserved_orders' using detail = v_unserved::text;
  end if;

  v_counted := public._denoms_total(p_denoms);
  v_expected := public._drawer_balance(p_day);

  update public.business_days
     set status = 'closed', closed_at = now(), closed_by = v_me.id, closed_by_name = v_me.display_name,
         expected_cash = v_expected, counted_cash = v_counted, variance = v_counted - v_expected,
         closing_denoms = p_denoms, close_note = nullif(left(btrim(coalesce(p_note, '')), 200), '')
   where id = p_day
   returning * into v_day;

  perform public._audit(v_me, 'close_day', 'business_day', p_day,
    jsonb_build_object('expected', v_expected, 'counted', v_counted, 'variance', v_counted - v_expected,
                       'unserved_orders', v_unserved));
  return to_jsonb(v_day) || jsonb_build_object('unserved_orders', v_unserved);
end $$;

create or replace function public.reopen_business_day(p_day uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_day public.business_days;
  v_prev jsonb;
begin
  v_me := public._require_admin();
  if exists (select 1 from public.business_days where status = 'open') then
    raise exception 'day_already_open';
  end if;
  select * into v_day from public.business_days where id = p_day for update;
  if not found then raise exception 'day_not_found'; end if;
  if v_day.status <> 'closed' then raise exception 'day_not_closed'; end if;
  v_prev := jsonb_build_object('expected', v_day.expected_cash, 'counted', v_day.counted_cash,
                               'variance', v_day.variance, 'denoms', v_day.closing_denoms);
  update public.business_days
     set status = 'open', closed_at = null, closed_by = null, closed_by_name = null,
         expected_cash = null, counted_cash = null, variance = null, closing_denoms = null, close_note = null
   where id = p_day
   returning * into v_day;
  perform public._audit(v_me, 'reopen_day', 'business_day', p_day, jsonb_build_object('previous_close', v_prev));
  return to_jsonb(v_day);
end $$;

-- ---------------------------------------------------------------------
-- 7. RPC: 会計(注文確定・連番発行)
--    * 単価・商品名はサーバー側の products から取得(端末の値は信用しない)
--    * 営業日の行をロックして連番を採番 → 同時会計でも重複しない
--    * request_id で冪等: 通信断で再送しても二重登録されない
-- ---------------------------------------------------------------------

create or replace function public.create_order(
  p_request_id uuid, p_items jsonb, p_received integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_day public.business_days;
  v_existing uuid;
  v_total integer := 0;
  v_order_no integer;
  v_order_id uuid;
  r record;
begin
  v_me := public._require_staff();
  if p_request_id is null then raise exception 'request_id_required'; end if;

  -- 冪等(高速パス)
  select id into v_existing from public.orders where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate', true, 'order', public._order_json_by_id(v_existing));
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items';
  end if;

  -- 営業日の行をロック(同時会計を直列化)
  select * into v_day from public.business_days where status = 'open' for update;
  if not found then raise exception 'no_open_day'; end if;

  -- ロック取得後にもう一度(同じ request_id が同時に来た場合)
  select id into v_existing from public.orders where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate', true, 'order', public._order_json_by_id(v_existing));
  end if;

  -- 明細を検証して合計を計算(同一商品は合算)
  for r in
    select req.product_id, req.qty, p.name, p.price, p.visible, p.sold_out
      from (
        select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'qty')::integer) as qty
          from jsonb_array_elements(p_items) e
         group by 1
      ) req
      left join public.products p on p.id = req.product_id
  loop
    if r.name is null then raise exception 'product_not_found'; end if;
    if not r.visible then raise exception 'product_hidden' using detail = r.name; end if;
    if r.sold_out then raise exception 'product_sold_out' using detail = r.name; end if;
    if r.qty < 1 or r.qty > 99 then raise exception 'invalid_qty'; end if;
    v_total := v_total + r.qty * r.price;
  end loop;

  if v_total <= 0 or v_total > 10000000 then raise exception 'invalid_total'; end if;
  if p_received is null or p_received < v_total then
    raise exception 'insufficient_received' using detail = v_total::text;
  end if;
  if p_received > 100000000 then raise exception 'invalid_received'; end if;

  v_order_no := v_day.next_order_no;
  update public.business_days set next_order_no = next_order_no + 1 where id = v_day.id;

  insert into public.orders (business_day_id, order_no, request_id, staff_id, staff_name,
                             total, received, change_given)
  values (v_day.id, v_order_no, p_request_id, v_me.id, v_me.display_name,
          v_total, p_received, p_received - v_total)
  returning id into v_order_id;

  insert into public.order_items (order_id, business_day_id, line_no, product_id, name, unit_price, qty)
  select v_order_id, v_day.id,
         row_number() over (order by p.sort_order, p.created_at, p.id),
         p.id, p.name, p.price, req.qty
    from (
      select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'qty')::integer)::integer as qty
        from jsonb_array_elements(p_items) e
       group by 1
    ) req
    join public.products p on p.id = req.product_id;

  insert into public.cash_events (business_day_id, kind, amount, order_id, staff_id, staff_name)
  values (v_day.id, 'sale', v_total, v_order_id, v_me.id, v_me.display_name);

  perform public._audit(v_me, 'create_order', 'order', v_order_id,
    jsonb_build_object('order_no', v_order_no, 'total', v_total, 'received', p_received));

  return jsonb_build_object('duplicate', false, 'order', public._order_json_by_id(v_order_id));
end $$;

-- 会計取消(全額返金)
create or replace function public.void_order(p_order uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_order public.orders;
  v_day public.business_days;
begin
  v_me := public._require_admin();
  select * into v_order from public.orders where id = p_order;
  if not found then raise exception 'order_not_found'; end if;

  select * into v_day from public.business_days where id = v_order.business_day_id for update;
  select * into v_order from public.orders where id = p_order for update;

  if v_order.status = 'voided' then
    return jsonb_build_object('already_voided', true, 'order', public._order_json_by_id(p_order));
  end if;
  if v_day.status <> 'open' then raise exception 'day_closed'; end if;
  if public._drawer_balance(v_day.id) < v_order.total then
    raise exception 'insufficient_cash' using detail = v_order.total::text;
  end if;

  update public.orders
     set status = 'voided', voided_at = now(), voided_by = v_me.id, voided_by_name = v_me.display_name,
         void_reason = nullif(left(btrim(coalesce(p_reason, '')), 200), '')
   where id = p_order;

  insert into public.cash_events (business_day_id, kind, amount, order_id, staff_id, staff_name, note)
  values (v_day.id, 'refund', -v_order.total, p_order, v_me.id, v_me.display_name,
          '返金 No.' || lpad(v_order.order_no::text, 3, '0'));

  perform public._audit(v_me, 'void_order', 'order', p_order,
    jsonb_build_object('order_no', v_order.order_no, 'total', v_order.total, 'reason', p_reason));
  return jsonb_build_object('already_voided', false, 'order', public._order_json_by_id(p_order));
end $$;

-- ---------------------------------------------------------------------
-- 8. RPC: 受け渡し(二重提供の防止)
-- ---------------------------------------------------------------------

-- 明細 1 行の提供数量を p_from → p_to に更新(比較して更新)。
-- 他のスタッフが先に変更していたら conflict を返して何もしない。
create or replace function public.serve_item(p_item uuid, p_from integer, p_to integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_order_id uuid;
  v_day_id uuid;
  v_order public.orders;
  v_item public.order_items;
begin
  v_me := public._require_staff();
  select i.order_id, i.business_day_id into v_order_id, v_day_id from public.order_items i where i.id = p_item;
  if not found then raise exception 'item_not_found'; end if;

  -- ロック順序: 営業日 → 注文 → 明細
  perform public._lock_day_shared(v_day_id);
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_item from public.order_items where id = p_item for update;

  if v_order.status <> 'paid' then raise exception 'order_voided'; end if;
  if not exists (select 1 from public.business_days where id = v_order.business_day_id and status = 'open') then
    raise exception 'day_closed';
  end if;
  if p_from is null or p_to is null or p_to < 0 or p_to > v_item.qty then
    raise exception 'invalid_qty';
  end if;

  if v_item.served_qty <> p_from then
    return jsonb_build_object('ok', false, 'reason', 'conflict',
      'served_qty', v_item.served_qty, 'served_by', v_item.last_served_by_name,
      'order', public._order_json_by_id(v_order_id));
  end if;
  if p_to = p_from then
    return jsonb_build_object('ok', true, 'changed', false, 'order', public._order_json_by_id(v_order_id));
  end if;

  update public.order_items
     set served_qty = p_to, last_served_by_name = v_me.display_name, last_served_at = now()
   where id = p_item;
  insert into public.serve_events (business_day_id, order_id, order_item_id, item_name, delta, staff_id, staff_name)
  values (v_order.business_day_id, v_order_id, p_item, v_item.name, p_to - p_from, v_me.id, v_me.display_name);
  perform public._refresh_order_served(v_order_id);

  return jsonb_build_object('ok', true, 'changed', true, 'order', public._order_json_by_id(v_order_id));
end $$;

-- 注文の残りをすべて提供済みにする(すでに全品提供済みなら already_served)
create or replace function public.serve_order(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_day_id uuid;
  v_order public.orders;
  v_item record;
  v_changed integer := 0;
  v_prev_by text;
begin
  v_me := public._require_staff();
  select business_day_id into v_day_id from public.orders where id = p_order;
  if not found then raise exception 'order_not_found'; end if;
  perform public._lock_day_shared(v_day_id);
  select * into v_order from public.orders where id = p_order for update;
  if v_order.status <> 'paid' then raise exception 'order_voided'; end if;
  if not exists (select 1 from public.business_days where id = v_order.business_day_id and status = 'open') then
    raise exception 'day_closed';
  end if;

  for v_item in
    select * from public.order_items where order_id = p_order and served_qty < qty order by line_no for update
  loop
    update public.order_items
       set served_qty = qty, last_served_by_name = v_me.display_name, last_served_at = now()
     where id = v_item.id;
    insert into public.serve_events (business_day_id, order_id, order_item_id, item_name, delta, staff_id, staff_name)
    values (v_order.business_day_id, p_order, v_item.id, v_item.name, v_item.qty - v_item.served_qty,
            v_me.id, v_me.display_name);
    v_changed := v_changed + 1;
  end loop;

  if v_changed = 0 then
    select max(last_served_by_name) into v_prev_by from public.order_items where order_id = p_order;
  else
    perform public._refresh_order_served(p_order);
  end if;

  return jsonb_build_object('ok', true, 'already_served', v_changed = 0, 'served_by', v_prev_by,
                            'order', public._order_json_by_id(p_order));
end $$;

-- 提供の取り消し(誤操作の訂正): 注文の全明細を未提供に戻す
create or replace function public.unserve_order(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_day_id uuid;
  v_order public.orders;
  v_item record;
begin
  v_me := public._require_staff();
  select business_day_id into v_day_id from public.orders where id = p_order;
  if not found then raise exception 'order_not_found'; end if;
  perform public._lock_day_shared(v_day_id);
  select * into v_order from public.orders where id = p_order for update;
  if v_order.status <> 'paid' then raise exception 'order_voided'; end if;
  if not exists (select 1 from public.business_days where id = v_order.business_day_id and status = 'open') then
    raise exception 'day_closed';
  end if;

  for v_item in
    select * from public.order_items where order_id = p_order and served_qty > 0 order by line_no for update
  loop
    update public.order_items
       set served_qty = 0, last_served_by_name = v_me.display_name, last_served_at = now()
     where id = v_item.id;
    insert into public.serve_events (business_day_id, order_id, order_item_id, item_name, delta, staff_id, staff_name)
    values (v_order.business_day_id, p_order, v_item.id, v_item.name, -v_item.served_qty,
            v_me.id, v_me.display_name);
  end loop;
  perform public._refresh_order_served(p_order);
  return jsonb_build_object('ok', true, 'order', public._order_json_by_id(p_order));
end $$;

-- ---------------------------------------------------------------------
-- 9. RPC: 現金(補充・回収)
-- ---------------------------------------------------------------------

create or replace function public.record_cash_event(
  p_request_id uuid, p_kind text, p_amount integer, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_day public.business_days;
  v_existing public.cash_events;
  v_signed integer;
  v_event public.cash_events;
begin
  v_me := public._require_admin();
  if p_request_id is null then raise exception 'request_id_required'; end if;
  if p_kind not in ('replenish', 'collect') then raise exception 'invalid_kind'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then raise exception 'invalid_amount'; end if;

  select * into v_existing from public.cash_events where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate', true, 'balance', public._drawer_balance(v_existing.business_day_id));
  end if;

  select * into v_day from public.business_days where status = 'open' for update;
  if not found then raise exception 'no_open_day'; end if;

  select * into v_existing from public.cash_events where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate', true, 'balance', public._drawer_balance(v_day.id));
  end if;

  v_signed := case when p_kind = 'collect' then -p_amount else p_amount end;
  if p_kind = 'collect' and public._drawer_balance(v_day.id) < p_amount then
    raise exception 'insufficient_cash' using detail = p_amount::text;
  end if;

  insert into public.cash_events (business_day_id, kind, amount, staff_id, staff_name, note, request_id)
  values (v_day.id, p_kind, v_signed, v_me.id, v_me.display_name,
          nullif(left(btrim(coalesce(p_note, '')), 200), ''), p_request_id)
  returning * into v_event;

  perform public._audit(v_me, 'cash_' || p_kind, 'cash_event', v_event.id,
    jsonb_build_object('amount', p_amount, 'note', p_note));
  return jsonb_build_object('duplicate', false, 'balance', public._drawer_balance(v_day.id),
                            'event', to_jsonb(v_event));
end $$;

-- ---------------------------------------------------------------------
-- 10. RPC: 商品・スタッフ管理
-- ---------------------------------------------------------------------

create or replace function public.upsert_product(
  p_id uuid, p_name text, p_price integer, p_category text default 'food',
  p_sort_order integer default 0, p_visible boolean default true
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_before public.products;
  v_row public.products;
begin
  v_me := public._require_admin();
  if p_name is null or char_length(btrim(p_name)) = 0 or char_length(btrim(p_name)) > 40 then
    raise exception 'invalid_name';
  end if;
  if p_price is null or p_price < 0 or p_price > 1000000 then raise exception 'invalid_amount'; end if;
  if p_category not in ('food', 'drink', 'other') then raise exception 'invalid_category'; end if;

  if p_id is null then
    insert into public.products (name, price, category, sort_order, visible)
    values (btrim(p_name), p_price, p_category, coalesce(p_sort_order, 0), coalesce(p_visible, true))
    returning * into v_row;
    perform public._audit(v_me, 'product_create', 'product', v_row.id,
      jsonb_build_object('name', v_row.name, 'price', v_row.price));
  else
    select * into v_before from public.products where id = p_id for no key update;
    if not found then raise exception 'product_not_found'; end if;
    update public.products
       set name = btrim(p_name), price = p_price, category = p_category,
           sort_order = coalesce(p_sort_order, sort_order), visible = coalesce(p_visible, visible),
           updated_at = now()
     where id = p_id
     returning * into v_row;
    perform public._audit(v_me, 'product_update', 'product', p_id,
      jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_row)));
  end if;
  return to_jsonb(v_row);
end $$;

create or replace function public.delete_product(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_row public.products;
begin
  v_me := public._require_admin();
  delete from public.products where id = p_id returning * into v_row;
  if not found then raise exception 'product_not_found'; end if;
  perform public._audit(v_me, 'product_delete', 'product', p_id,
    jsonb_build_object('name', v_row.name, 'price', v_row.price));
  return jsonb_build_object('deleted', true);
end $$;

-- 売り切れ切替は一般スタッフも可能
create or replace function public.set_sold_out(p_product uuid, p_sold_out boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_row public.products;
begin
  v_me := public._require_staff();
  update public.products set sold_out = coalesce(p_sold_out, false), updated_at = now()
   where id = p_product returning * into v_row;
  if not found then raise exception 'product_not_found'; end if;
  perform public._audit(v_me, 'product_sold_out', 'product', p_product,
    jsonb_build_object('name', v_row.name, 'sold_out', v_row.sold_out));
  return to_jsonb(v_row);
end $$;

create or replace function public.admin_update_staff(
  p_user uuid, p_active boolean, p_role text, p_display_name text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_before public.profiles;
  v_row public.profiles;
  v_other_admins integer;
  v_new_active boolean;
begin
  v_me := public._require_admin();
  perform pg_advisory_xact_lock(7321001);
  select * into v_before from public.profiles where id = p_user for no key update;
  if not found then raise exception 'staff_not_found'; end if;
  if p_role not in ('admin', 'staff') then raise exception 'invalid_role'; end if;
  if p_display_name is not null
     and (char_length(btrim(p_display_name)) = 0 or char_length(btrim(p_display_name)) > 30) then
    raise exception 'invalid_name';
  end if;

  select count(*) into v_other_admins
    from public.profiles where role = 'admin' and active and id <> p_user;
  v_new_active := coalesce(p_active, v_before.active);
  if v_other_admins = 0 and not (v_new_active and p_role = 'admin') then
    raise exception 'last_admin';
  end if;

  update public.profiles
     set active = v_new_active, role = p_role,
         display_name = coalesce(btrim(p_display_name), display_name)
   where id = p_user
   returning * into v_row;

  perform public._audit(v_me, 'staff_update', 'profile', p_user,
    jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_row)));
  return to_jsonb(v_row);
end $$;

-- ---------------------------------------------------------------------
-- 11. 読み取り用関数(security invoker = RLS が効く)
-- ---------------------------------------------------------------------

-- 画面表示に必要な情報を 1 回で返す
create or replace function public.app_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_me jsonb;
  v_day jsonb;
  v_day_id uuid;
begin
  select to_jsonb(p) into v_me from public.profiles p where p.id = auth.uid();
  if v_me is null or not (v_me ->> 'active')::boolean then
    return jsonb_build_object('schema_version', 1, 'me', v_me);
  end if;

  select to_jsonb(d), d.id into v_day, v_day_id from public.business_days d where d.status = 'open' limit 1;

  return jsonb_build_object(
    'schema_version', 1,
    'server_time', now(),
    'me', v_me,
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
                                       order by created_at desc limit 300) e), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(
                         case when public.is_admin() then to_jsonb(s)
                              else jsonb_build_object('id', s.id, 'display_name', s.display_name) end
                         order by s.created_at)
                         from public.profiles s), '[]'::jsonb)
  );
end $$;

create or replace function public.sales_summary(p_day uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_day uuid := coalesce(p_day, public.current_open_day());
begin
  if v_day is null then
    return jsonb_build_object('day_id', null, 'sales_total', 0, 'order_count', 0, 'voided_count', 0,
      'voided_total', 0, 'item_count', 0, 'by_product', '[]'::jsonb, 'by_staff', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'day_id', v_day,
    'sales_total', coalesce((select sum(total) from public.orders where business_day_id = v_day and status = 'paid'), 0),
    'order_count', (select count(*) from public.orders where business_day_id = v_day and status = 'paid'),
    'voided_count', (select count(*) from public.orders where business_day_id = v_day and status = 'voided'),
    'voided_total', coalesce((select sum(total) from public.orders where business_day_id = v_day and status = 'voided'), 0),
    'item_count', coalesce((select sum(i.qty) from public.order_items i
                              join public.orders o on o.id = i.order_id
                             where o.business_day_id = v_day and o.status = 'paid'), 0),
    'by_product', coalesce((select jsonb_agg(x order by x.qty desc, x.name)
                              from (select i.name, sum(i.qty)::integer as qty,
                                           sum(i.qty * i.unit_price)::integer as amount
                                      from public.order_items i
                                      join public.orders o on o.id = i.order_id
                                     where o.business_day_id = v_day and o.status = 'paid'
                                     group by i.name) x), '[]'::jsonb),
    'by_staff', coalesce((select jsonb_agg(x order by x.amount desc, x.staff_name)
                            from (select o.staff_name, count(*)::integer as order_count,
                                         sum(o.total)::integer as amount
                                    from public.orders o
                                   where o.business_day_id = v_day and o.status = 'paid'
                                   group by o.staff_name) x), '[]'::jsonb)
  );
end $$;

-- 営業日別の売上・現金過不足(管理者)
create or replace function public.sales_by_day()
returns jsonb language plpgsql stable security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x order by x.business_date desc)
      from (
        select d.id, d.business_date, d.status, d.opening_float, d.expected_cash, d.counted_cash, d.variance,
               d.closed_at, d.close_note,
               coalesce(sum(o.total) filter (where o.status = 'paid'), 0)::integer as sales_total,
               (count(o.id) filter (where o.status = 'paid'))::integer as order_count,
               (count(o.id) filter (where o.status = 'voided'))::integer as voided_count,
               (select coalesce(sum(c.amount), 0)::integer from public.cash_events c where c.business_day_id = d.id) as balance
          from public.business_days d
          left join public.orders o on o.business_day_id = d.id
         group by d.id
      ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.day_detail(p_day uuid)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'day', (select to_jsonb(d) from public.business_days d where d.id = p_day),
    'orders', coalesce((select jsonb_agg(public._order_json(o) order by o.order_no)
                          from public.orders o where o.business_day_id = p_day), '[]'::jsonb),
    'cash_events', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at)
                               from public.cash_events c where c.business_day_id = p_day), '[]'::jsonb)
  );
end $$;

-- CSV 出力用(明細 1 行 = 1 レコード)。p_day が null なら全営業日。
create or replace function public.export_rows(p_day uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x order by x.business_date, x.order_no, x.line_no)
      from (
        select d.business_date, o.order_no, o.created_at, o.staff_name, o.status,
               i.line_no, i.name as item_name, i.unit_price, i.qty, (i.unit_price * i.qty) as line_total,
               o.total as order_total, o.received, o.change_given, o.served_at, o.void_reason
          from public.orders o
          join public.business_days d on d.id = o.business_day_id
          join public.order_items i on i.order_id = o.id
         where p_day is null or o.business_day_id = p_day
      ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.list_audit(p_limit integer default 200)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(a) order by a.at desc)
      from (select * from public.audit_log order by at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) a
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 12. 関数の実行権限(必要なものだけ authenticated に付与。anon は不可)
-- ---------------------------------------------------------------------

revoke all on all functions in schema public from public;
revoke all on all functions in schema public from anon;
revoke all on all functions in schema public from authenticated;

-- RLS ポリシー / invoker 関数から呼ばれるもの
grant execute on function public.is_active_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.current_open_day() to authenticated;
grant execute on function public._order_json(public.orders) to authenticated;

-- 端末から呼ぶ RPC
grant execute on function public.open_business_day(integer, jsonb, date) to authenticated;
grant execute on function public.close_business_day(uuid, jsonb, text, boolean) to authenticated;
grant execute on function public.reopen_business_day(uuid) to authenticated;
grant execute on function public.create_order(uuid, jsonb, integer) to authenticated;
grant execute on function public.void_order(uuid, text) to authenticated;
grant execute on function public.serve_item(uuid, integer, integer) to authenticated;
grant execute on function public.serve_order(uuid) to authenticated;
grant execute on function public.unserve_order(uuid) to authenticated;
grant execute on function public.record_cash_event(uuid, text, integer, text) to authenticated;
grant execute on function public.upsert_product(uuid, text, integer, text, integer, boolean) to authenticated;
grant execute on function public.delete_product(uuid) to authenticated;
grant execute on function public.set_sold_out(uuid, boolean) to authenticated;
grant execute on function public.admin_update_staff(uuid, boolean, text, text) to authenticated;
grant execute on function public.app_snapshot() to authenticated;
grant execute on function public.sales_summary(uuid) to authenticated;
grant execute on function public.sales_by_day() to authenticated;
grant execute on function public.day_detail(uuid) to authenticated;
grant execute on function public.export_rows(uuid) to authenticated;
grant execute on function public.list_audit(integer) to authenticated;

-- 今後作る関数が anon / public に自動公開されないようにする
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

-- ---------------------------------------------------------------------
-- 13. リアルタイム配信(Supabase Realtime)
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['products', 'business_days', 'orders', 'order_items',
                             'serve_events', 'cash_events', 'profiles'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 14. 初期商品(管理画面で変更・追加できます)
-- ---------------------------------------------------------------------

insert into public.products (name, price, category, sort_order) values
  ('おでん(5個入り)', 500, 'food', 10),
  ('コーヒー', 300, 'drink', 20),
  ('カフェラテ', 300, 'drink', 30),
  ('紅茶', 300, 'drink', 40),
  ('ゆず蜂蜜', 300, 'drink', 50),
  ('ココア', 300, 'drink', 60),
  ('ぜんざい', 400, 'food', 70);
