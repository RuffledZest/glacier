# Glacier

Deploy static sites from GitHub to Walrus (Sui). **Sign-in is GitHub OAuth only**; builds and on-chain deploys use the platform wallet (`SUI_KEYSTORE` / `SUI_ADDRESS` on the worker).

## Configuration

### Worker (Wrangler / Cloudflare dashboard)

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Secret for session JWTs and OAuth `state` signing. |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID. |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret (secret in dashboard). |
| `FRONTEND_URL` | Yes | Origin of the web app for post-login redirect (e.g. `https://app.example.com`). Callback redirects to `{FRONTEND_URL}/deploy#token=…`. |
| `GITHUB_REDIRECT_URI` | Recommended | Full callback URL registered in the GitHub app (e.g. `https://api.example.com/api/github/callback`). If omitted, `{API_PUBLIC_URL}/api/github/callback` is used. |
| `API_PUBLIC_URL` | If no `GITHUB_REDIRECT_URI` | Public origin of this worker (no trailing slash), used to build the default OAuth callback URL. |
| `SUI_KEYSTORE`, `SUI_ADDRESS` | For deploy | Platform wallet used to publish sites. |
| `WEBHOOK_SECRET`, `GITHUB_TOKEN` | Optional | Webhooks and unauthenticated GitHub API fallback. |

### Frontend (Vite)

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE` | API prefix pointing at the worker (default `/api`). Example for local dev: `http://127.0.0.1:8787/api`. Production: set when running `npm run build` (see Deploy section). |

See [`frontend/.env.example`](frontend/.env.example).

Local dev: copy secrets into `worker/.dev.vars` (Wrangler). Set `FRONTEND_URL` and `API_PUBLIC_URL` there (or in the dashboard for production) so GitHub OAuth redirects match your URLs. [`worker/wrangler.jsonc`](worker/wrangler.jsonc) only ships non-secret defaults like `WALRUS_*`.

### Deploy (production)

1. **Wrangler account**: `npx wrangler whoami` must be able to access the Cloudflare account that owns D1 `glacier-db` and Worker `glacier`. If API calls fail with **Authentication error [code: 10000]** against a different account id than `whoami`, log in with a user that has access to that account (`npx wrangler login`), or use an **API token** with Workers + D1 permissions for the correct account (`CLOUDFLARE_API_TOKEN`).

2. **Worker** (preserves dashboard vars/secrets; do not delete remote-only `FRONTEND_URL` / `API_PUBLIC_URL`):

```bash
cd worker
npx wrangler deploy --keep-vars --message "Release"
```

3. **Frontend** (set the live worker API URL at **build** time):

```bash
cd frontend
VITE_API_BASE='https://<your-worker-host>/api' npm run build
npx wrangler pages deploy dist --project-name='<your-pages-project>'
```

Confirm in the Cloudflare dashboard that **secrets** exist: `JWT_SECRET`, `GITHUB_CLIENT_SECRET`, and any others you use (`SUI_KEYSTORE`, `WEBHOOK_SECRET`, …), and **vars**: `GITHUB_CLIENT_ID`, `FRONTEND_URL`, `API_PUBLIC_URL` or `GITHUB_REDIRECT_URI`, `SUI_ADDRESS`, `WALRUS_*`, etc.

### GitHub OAuth App

- **Callback URL** must exactly match `GITHUB_REDIRECT_URI`, or `{API_PUBLIC_URL}/api/github/callback` if you only set `API_PUBLIC_URL`.

## Resetting D1 (development)

If you switch from wallet-based user ids to GitHub ids, old rows will not match new accounts. To wipe local or remote D1 data:

1. **Dashboard**: Cloudflare → D1 → your database → delete tables or run SQL.
2. **CLI** (replace database id/name from `wrangler.jsonc`):

```bash
cd worker
npx wrangler d1 execute glacier-db --local --command "DELETE FROM github_tokens; DELETE FROM deployments; DELETE FROM projects;"
```

Use `--remote` instead of `--local` for the deployed database. Adjust table list if your schema differs.

## Scripts

- **Frontend**: `cd frontend && npm run dev`
- **Worker**: `cd worker && npm run dev`
