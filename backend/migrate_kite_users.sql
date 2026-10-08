-- Run once in the Supabase SQL editor, as the database owner.
-- Keep the application closed during migration, then restart the new backend.
-- Existing IDs, holdings, names and definitions are preserved. All unowned
-- personal data is assigned to the verified legacy Kite account GEK191.
-- Re-running this file does not reassign records that already have an owner.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('kite-dashboard-user-ownership-v1'));
CREATE TABLE IF NOT EXISTS public.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kite_user_id text NOT NULL UNIQUE CHECK (kite_user_id ~ '^[A-Z0-9]{3,20}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.app_users (kite_user_id) VALUES ('GEK191') ON CONFLICT (kite_user_id) DO NOTHING;

DO $$
DECLARE
  tbl text;
  legacy_owner uuid;
  constraint_row record;
  natural_keys text[];
BEGIN
  SELECT id INTO STRICT legacy_owner FROM public.app_users WHERE kite_user_id = 'GEK191';
  FOREACH tbl IN ARRAY ARRAY['portfolios','portfolio_holdings','themes','theme_instruments','saved_screens',
    'us_baskets','us_virtual_portfolios','us_screens','instrument_notes','backtest_runs','trade_log',
    'user_events','holding_state_snapshots','stop_proposals']
  LOOP
    IF to_regclass(format('public.%I', tbl)) IS NULL THEN
      IF tbl = ANY(ARRAY['portfolios','portfolio_holdings','themes','theme_instruments','saved_screens','us_baskets','us_virtual_portfolios','us_screens']) THEN
        RAISE EXCEPTION 'Required workspace table % is missing; migration has been rolled back', tbl;
      END IF;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS user_id uuid', tbl);
    EXECUTE format('UPDATE public.%I SET user_id = $1 WHERE user_id IS NULL', tbl) USING legacy_owner;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET NOT NULL', tbl);
    IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = to_regclass(format('public.%I',tbl)) AND conname = tbl || '_user_owner_fk') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES public.app_users(id)', tbl, tbl || '_user_owner_fk');
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (user_id)', tbl || '_user_owner_idx', tbl);
    -- Natural keys must be unique per user. UUID record IDs retain their
    -- original primary keys; a scoped unique key supports owned child FKs.
    FOR constraint_row IN
      SELECT c.conname,c.contype,array_agg(a.attname::text ORDER BY k.ordinality) AS columns
      FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = to_regclass(format('public.%I',tbl)) AND c.contype IN ('p','u')
      GROUP BY c.conname,c.contype
    LOOP
      natural_keys := constraint_row.columns;
      IF NOT ('user_id' = ANY(natural_keys)) AND NOT (natural_keys = ARRAY['id']) THEN
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', tbl, constraint_row.conname);
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s (user_id,%s)', tbl, constraint_row.conname,
          CASE WHEN constraint_row.contype = 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END,
          (SELECT string_agg(quote_ident(col),',') FROM unnest(natural_keys) AS col));
      END IF;
    END LOOP;
    IF EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass(format('public.%I',tbl)) AND attname = 'id' AND NOT attisdropped) THEN
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (user_id,id)', tbl || '_owned_id_idx', tbl);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', tbl);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', tbl);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM readonly_user', tbl);
    END IF;
  END LOOP;
END $$;

-- Cross-user child relationships are rejected even if a caller guesses a UUID.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='portfolio_holdings_owned_parent_fk' AND conrelid='public.portfolio_holdings'::regclass) THEN
    ALTER TABLE public.portfolio_holdings ADD CONSTRAINT portfolio_holdings_owned_parent_fk
      FOREIGN KEY(user_id,portfolio_id) REFERENCES public.portfolios(user_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='theme_instruments_owned_parent_fk' AND conrelid='public.theme_instruments'::regclass) THEN
    ALTER TABLE public.theme_instruments ADD CONSTRAINT theme_instruments_owned_parent_fk
      FOREIGN KEY(user_id,theme_id) REFERENCES public.themes(user_id,id) ON DELETE CASCADE;
  END IF;
END $$;

-- Holding-derived signal inputs are private; market-only studies keep their
-- existing public table. Copy old account signals without deleting originals.
CREATE TABLE IF NOT EXISTS public.user_signal_emissions (
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  signal text NOT NULL, snap_date date NOT NULL, symbol text NOT NULL,
  source text NOT NULL DEFAULT 'recorded', meta jsonb,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY(user_id,signal,snap_date,symbol)
);
DO $$ BEGIN
  IF to_regclass('public.signal_emissions') IS NOT NULL THEN
    INSERT INTO public.user_signal_emissions(user_id,signal,snap_date,symbol,source,meta,created_at)
      SELECT u.id,s.signal,s.snap_date,s.symbol,s.source,s.meta,s.created_at
      FROM public.signal_emissions s CROSS JOIN public.app_users u
      WHERE u.kite_user_id='GEK191' AND s.signal LIKE 'technical_alert/%'
      ON CONFLICT(user_id,signal,snap_date,symbol) DO NOTHING;
    ALTER TABLE public.signal_emissions ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS(SELECT FROM pg_policy WHERE polrelid='public.signal_emissions'::regclass AND polname='hide_legacy_account_signals') THEN
      CREATE POLICY hide_legacy_account_signals ON public.signal_emissions AS RESTRICTIVE FOR SELECT
        USING(signal NOT LIKE 'technical_alert/%');
    END IF;
  END IF;
END $$;
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_signal_emissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_users,public.user_signal_emissions FROM anon,authenticated;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_users,public.user_signal_emissions TO service_role;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='readonly_user') THEN
    REVOKE ALL ON public.app_users,public.user_signal_emissions FROM readonly_user;
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;

-- Verification: these counts should match your current saved collections.
SELECT u.kite_user_id,
  (SELECT count(*) FROM public.portfolios p WHERE p.user_id=u.id) AS indian_portfolios,
  (SELECT count(*) FROM public.portfolio_holdings h WHERE h.user_id=u.id) AS indian_holdings,
  (SELECT count(*) FROM public.themes t WHERE t.user_id=u.id) AS indian_baskets,
  (SELECT count(*) FROM public.theme_instruments i WHERE i.user_id=u.id) AS indian_basket_instruments,
  (SELECT count(*) FROM public.saved_screens s WHERE s.user_id=u.id) AS indian_screeners,
  (SELECT count(*) FROM public.us_virtual_portfolios p WHERE p.user_id=u.id) AS us_portfolios,
  (SELECT count(*) FROM public.us_baskets b WHERE b.user_id=u.id) AS us_baskets,
  (SELECT count(*) FROM public.us_screens s WHERE s.user_id=u.id) AS us_screeners
FROM public.app_users u WHERE u.kite_user_id='GEK191';
