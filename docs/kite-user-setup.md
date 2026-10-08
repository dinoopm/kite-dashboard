# Activate Kite-only user workspaces

The app uses the authenticated Kite profile as the login identity. There is no
email/password login. The backend maps the verified Kite user ID to an internal
UUID in `app_users`; saved workspaces belong to that UUID. A future login provider
can map to the same UUID without moving the saved records again.

## Run the ownership migration

1. Stop the backend before migrating. The previous backend cannot save rows
   after `user_id` becomes required. Keep it stopped until the migration succeeds.
2. Open the Supabase project used by this app, then **SQL Editor → New query**.
3. Paste the **entire** contents of [migrate_kite_users.sql](../backend/migrate_kite_users.sql)
   and run it as the database owner. No database connection string needs to be
   added to `.env` or shared in chat.
4. Confirm the final result identifies **GEK191**. Unless your saved collections
   have changed since inspection, the expected counts are:

   | Column | Expected |
   | --- | ---: |
   | indian_portfolios | 5 |
   | indian_holdings | 27 |
   | indian_baskets | 14 |
   | indian_basket_instruments | 597 |
   | indian_screeners | 9 |
   | us_portfolios | 1 |
   | us_baskets | 5 |
   | us_screeners | 1 |

5. Restart this updated backend from the project directory with
   `npm start --prefix backend`. Keep Vite running on `http://localhost:5173`,
   or run `npm run dev --prefix frontend` if it is stopped.
6. Reload the app and use **Login to Kite → Continue to Kite**. Authorize GEK191
   and confirm the saved Indian and US portfolios, baskets and screeners appear
   under this account. The navbar does not display the account ID.

Run the full file, including `BEGIN` and `COMMIT`. A missing required table,
invalid relationship, or lock timeout aborts the transaction. If the SQL editor
reports an error, do not start the app or run fragments of the migration; share
only the error text. An aborted editor session can be cleared with `ROLLBACK`
before rerunning the full file. Rerunning preserves existing owners and record
IDs; it does not duplicate the seed user or copied account signals.

## What the migration changes

Existing saved collections keep their IDs, names, holdings and JSON definitions.
Only unowned personal rows receive the owner linked to GEK191. The same migration
also scopes instrument notes, backtest runs, journal fills, personal events,
holding snapshots and protective-stop proposals when those tables exist.

Natural keys such as a journal trade ID or a stock-note symbol become unique per
user. Composite foreign keys prevent holdings and instruments from being linked
to another user's portfolio or basket. Existing account-derived signal evidence
is copied into an owned table; the original evidence remains stored but is
excluded from public signal reads. Public price data and market-only studies
continue using their existing tables.

Private tables have RLS enabled and client-role access revoked. Because the
backend uses a Supabase service key, backend ownership filters are also required;
RLS alone does not isolate requests using that key. Never expose that key in the
frontend. Apply this migration with the accompanying backend changes, not with
the old shared-session backend.

## Session behaviour

Each browser login has a separate MCP client, credential folder, callback port,
HTTP worker, caches and background account jobs. New sessions do not reuse the
old global `~/.mcp-auth` login. Logging out closes only that session's worker and
removes its credential folder. Other users remain connected.

The browser holds an opaque HttpOnly, SameSite cookie; the cookie rotates after
server-side profile verification. No user ID supplied by the browser establishes
ownership. Sessions expire after two idle hours or twelve hours total; unfinished
logins expire after thirty minutes. A backend restart requires a fresh login.
The gateway currently allows up to twenty concurrent sessions.

Tabs in the same browser profile share its cookie and update on sign-in/sign-out.
Use another browser profile or a private window to test two accounts at once.
A different Kite account starts with empty personal collections; it cannot see
GEK191's records. Personal browser preferences use account-specific keys; legacy
preferences are migrated only for GEK191. Holdings are not stored in browser
persistence.

For a hosted HTTPS deployment, set `APP_ORIGIN` to the frontend origin, for example
`https://your-app.example`. This enables secure cookies and permits that origin
for write requests. The default local origin is `http://localhost:5173`. Workers
listen only on loopback and require a random gateway secret on every request.
MCP credentials live under ignored `backend/data/kite-sessions/`; do not copy that
folder or the legacy MCP credential cache to another machine or into Git.

## Validation performed before migration

- The SQL ran against an isolated Postgres engine using the project's existing
  schema definitions and synthetic data. Tests cover payload preservation,
  reruns, two owners with identical natural keys, cross-owner relationships,
  required/optional tables, private-role restrictions and service-role access.
- Session tests cover anonymous requests, cookie rotation, two concurrent
  accounts, spoofed user headers, logout isolation, expiry, changed broker
  identity, upstream failures, rate-limit headers and capacity limits.
- Real local worker tests verify distinct credential directories, callback ports
  and worker secrets without calling the broker or database.
- Backend: 703 tests passed. Frontend: 255 tests passed. Production build passed.
- New backend modules and changed frontend files lint cleanly except the existing
  Dashboard file's 10 errors, unchanged from HEAD. Backend lint reports 16
  existing server errors plus one warning and one existing Alpaca error; HEAD
  had 18 server errors plus that warning and the same Alpaca error. No new
  violations were introduced.
- Controlled browser fixtures verify the login flow, account identity,
  saved collections, keyboard sign-out and a second account's empty workspace
  on desktop and mobile.

The user ran the migration on 2026-10-08. Live verification confirmed all eight
collection counts above and that the anonymous, authenticated and SQL-agent
roles cannot read the ten checked workspace tables. The updated backend was
restarted and returned a fresh, private Kite authorization link at
`http://localhost:5173`. Live saved-data loading is awaiting broker authorization
as GEK191; the app does not reuse the old shared Kite session.
