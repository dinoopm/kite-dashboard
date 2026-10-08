# Deploy the frontend and backend together

The current Node gateway serves both `/api/*` and the built React frontend.
Deploy the repository as one continuously running service. The root Dockerfile
builds the frontend, installs the backend, and includes Chromium for the existing
market-data scrapers. Kite login and per-user MCP workers retain their current
behaviour.

## One Railway service

1. Create a Railway service from this GitHub repository, using `main` and the
   repository root. Railway detects the root Dockerfile and `railway.json`.
2. Set these service variables privately:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | The existing Supabase project's URL |
   | `SUPABASE_SERVICE_KEY` | The existing backend service key |
   | `APP_ORIGIN` | The public HTTPS URL where users open this app, without a trailing slash |

   Reuse the database where `backend/migrate_kite_users.sql` has already run.
   Additional existing Alpaca/AI keys can be copied to service variables for
   those features. No secrets belong in the frontend or Git.
3. Generate a public Railway domain. If users open that domain, set `APP_ORIGIN`
   to it and redeploy. The service's injected `PORT` overrides the image default.
4. Keep **one replica** and disable service sleeping/serverless mode. The current
   sessions live in that replica; a restart requires users to sign in again.
5. Open the domain, choose **Login to Kite**, authorize, and confirm the correct
   account's holdings and saved workspaces load. Test a second browser profile
   for another account. `/healthz` returns `200` without logging in; an anonymous
   `/api/profile` returns JSON with status `401`.

The health check verifies the gateway is running. It does not assert that Kite
is authorized or that external providers are available.

Railway setup references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles),
[public networking](https://docs.railway.com/networking/public-networking), and
[configuration](https://docs.railway.com/config-as-code/reference).

## Keep the existing Vercel frontend

The same Railway service can supply just the API to the Vercel frontend.

1. Set the Railway service's `APP_ORIGIN` to
   `https://kite-dashboard-wvou.vercel.app`.
2. Copy `deploy/vercel.frontend.example.json` to `frontend/vercel.json` and replace
   `https://YOUR-BACKEND-HOST` with the Railway service's public HTTPS origin.
   Keep `/api/:path*` in the destination.
3. Configure Vercel's Root Directory as `frontend`, Framework as Vite, Build
   Command as `npm run build`, and Output Directory as `dist`. Redeploy.
4. Verify `/api/profile` on the Vercel URL returns JSON `401` before login, rather
   than `404` or HTML. Complete Kite login and confirm profile/holdings succeed.
   Refresh a page such as `/portfolio/risk` to check frontend routing.

The API proxy keeps requests and the HttpOnly session cookie on the frontend's
origin. The template disables API caching and provides the SPA route fallback.
See [Vercel rewrites](https://vercel.com/docs/routing/rewrites) and
[Vite deployment](https://vercel.com/docs/frameworks/frontend/vite).

## Local container check

With Docker running, build from the repository root:

```sh
docker build -t kite-dashboard .
docker run --rm -p 3001:3001 --env-file .env -e PORT=3001 -e APP_ORIGIN=http://localhost:3001 -e NODE_ENV=development kite-dashboard
```

Open `http://localhost:3001`. The local HTTP-only check disables secure cookies;
hosted deployments keep `NODE_ENV=production` and an HTTPS `APP_ORIGIN`.

## Validation on 2026-10-08

The production frontend build, changed backend lint checks, and six gateway/worker
tests passed. The Docker image built and ran on Linux/arm64 with synthetic
database settings. Checks confirmed frontend deep links and assets, `/healthz`
status `200`, anonymous `/api/profile` JSON status `401`, the configured Chromium
executable, and a private Kite authorization link from `/api/login`.

Railway configuration matched its published schema; the Vercel template matched
the published configuration fields. The container was not connected to the real
database and no broker account was authorized in it. Authenticated cloud profile
and holdings checks remain part of the deployment steps above. The build reported
existing npm dependency advisories, which this deployment change does not resolve.
