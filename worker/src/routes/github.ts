import { Hono } from 'hono'
import type { Env } from '..'
import { verifyJwt, createOAuthStateToken, verifyOAuthStateToken, createSessionJwt } from '../auth'
import {
  getOAuthUrl,
  exchangeCode,
  listRepos,
  listContents,
  detectProjects,
  quickDetectBatch,
  listCommits,
} from '../github-api'

const router = new Hono<{ Bindings: Env }>()

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

function resolveGithubRedirectUri(env: Env, requestUrl?: string): string | null {
  const explicit = env.GITHUB_REDIRECT_URI?.trim()
  if (explicit) return explicit
  const base = env.API_PUBLIC_URL?.trim()
  if (base) return `${trimSlash(base)}/api/github/callback`
  // Fallback: same origin as this request (works for *.workers.dev without dashboard vars).
  if (requestUrl) {
    try {
      const u = new URL(requestUrl)
      return `${u.origin}/api/github/callback`
    } catch {
      /* ignore */
    }
  }
  return null
}

function resolveFrontendBase(env: Env): string | null {
  const u = env.FRONTEND_URL?.trim()
  return u ? trimSlash(u) : null
}

// GET /api/github/login — start OAuth (no auth); returns { url }
router.get('/login', async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID
  if (!clientId) {
    return c.json({ error: 'GitHub OAuth not configured on server' }, 500)
  }

  const redirectUri = resolveGithubRedirectUri(c.env, c.req.url)
  if (!redirectUri) {
    return c.json(
      { error: 'Could not determine OAuth callback URL (set GITHUB_REDIRECT_URI or API_PUBLIC_URL)' },
      500
    )
  }

  const secret = c.env.JWT_SECRET
  if (!secret) {
    return c.json({ error: 'server misconfigured' }, 500)
  }

  const state = await createOAuthStateToken(secret)
  const url = getOAuthUrl(clientId, redirectUri, state)
  return c.json({ url })
})

// GET /api/github/callback — GitHub redirects here; issues session JWT + stores token
router.get('/callback', async (c) => {
  const frontend = resolveFrontendBase(c.env)
  const redirectWithHash = (fragment: string) => {
    if (!frontend) {
      return c.json({ error: 'FRONTEND_URL is not configured' }, 500)
    }
    return c.redirect(`${frontend}/dashboard#${fragment}`)
  }

  const code = c.req.query('code')
  const state = c.req.query('state')

  if (!code || !state) {
    return redirectWithHash(`error=${encodeURIComponent('missing OAuth parameters')}`)
  }

  const secret = c.env.JWT_SECRET
  if (!secret || !(await verifyOAuthStateToken(state, secret))) {
    return redirectWithHash(`error=${encodeURIComponent('invalid or expired OAuth state')}`)
  }

  const clientId = c.env.GITHUB_CLIENT_ID
  const clientSecret = c.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return redirectWithHash(`error=${encodeURIComponent('GitHub OAuth not configured')}`)
  }

  try {
    const { access_token, github_user, github_id } = await exchangeCode(code, clientId, clientSecret)
    const userId = `github:${github_id}`
    const db = c.env.DB
    await db
      .prepare(
        `INSERT INTO github_tokens (user_address, access_token, github_user, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(user_address) DO UPDATE SET
           access_token = excluded.access_token,
           github_user = excluded.github_user,
           updated_at = datetime('now')`
      )
      .bind(userId, access_token, github_user)
      .run()

    const sessionJwt = await createSessionJwt({ userId, githubLogin: github_user }, secret)
    return redirectWithHash(`token=${encodeURIComponent(sessionJwt)}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth failed'
    return redirectWithHash(`error=${encodeURIComponent(message)}`)
  }
})

// GET /api/github/status — check if user has GitHub linked (always true after login; useful for token row)
router.get('/status', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const db = c.env.DB
  const row = await db
    .prepare('SELECT access_token, github_user FROM github_tokens WHERE user_address = ?1')
    .bind(payload.address as string)
    .first<{ access_token: string; github_user: string | null }>()

  return c.json({
    connected: !!row,
    github_user: row?.github_user || null,
  })
})

// GET /api/github/repos — list user's repositories
router.get('/repos', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const db = c.env.DB
  const row = await db
    .prepare('SELECT access_token FROM github_tokens WHERE user_address = ?1')
    .bind(payload.address as string)
    .first<{ access_token: string }>()

  if (!row) {
    return c.json({ error: 'GitHub not connected' }, 401)
  }

  const page = parseInt(c.req.query('page') || '1')
  const repos = await listRepos(row.access_token, page)
  return c.json({ repos })
})

// GET /api/github/repos/:owner/:repo/contents — list repo contents
router.get('/repos/:owner/:repo/contents', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const db = c.env.DB
  const row = await db
    .prepare('SELECT access_token FROM github_tokens WHERE user_address = ?1')
    .bind(payload.address as string)
    .first<{ access_token: string }>()

  if (!row) {
    return c.json({ error: 'GitHub not connected' }, 401)
  }

  const { owner, repo } = c.req.param()
  const path = c.req.query('path') || ''

  const contents = await listContents(row.access_token, owner, repo, path)
  return c.json({ contents })
})

// GET /api/github/repos/:owner/:repo/commits — recent commits for branch picker
router.get('/repos/:owner/:repo/commits', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const db = c.env.DB
  const row = await db
    .prepare('SELECT access_token FROM github_tokens WHERE user_address = ?1')
    .bind(payload.address as string)
    .first<{ access_token: string }>()

  if (!row) {
    return c.json({ error: 'GitHub not connected' }, 401)
  }

  const { owner, repo } = c.req.param()
  const branch = c.req.query('branch') || 'main'
  const commits = await listCommits(row.access_token, owner, repo, branch, 20)
  return c.json({ commits })
})

// POST /api/github/repos/:owner/:repo/detect — deep scan for deployable projects
router.post('/repos/:owner/:repo/detect', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const db = c.env.DB
  const row = await db
    .prepare('SELECT access_token FROM github_tokens WHERE user_address = ?1')
    .bind(payload.address as string)
    .first<{ access_token: string }>()

  if (!row) {
    return c.json({ error: 'GitHub not connected' }, 401)
  }

  const { owner, repo } = c.req.param()
  const body = await c.req.json<{ branch?: string }>()
  const branch = body.branch || 'main'

  const projects = await detectProjects(row.access_token, owner, repo, branch)
  return c.json({ projects })
})

// GET /api/github/repos/:owner/:repo/branches — list branches (for webhook config)
router.get('/repos/:owner/:repo/branches', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const db = c.env.DB
  const row = await db
    .prepare('SELECT access_token FROM github_tokens WHERE user_address = ?1')
    .bind(payload.address as string)
    .first<{ access_token: string }>()

  if (!row) {
    return c.json({ error: 'GitHub not connected' }, 401)
  }

  const { owner, repo } = c.req.param()

  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${row.access_token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'polar',
      },
    }
  )

  if (!resp.ok) {
    return c.json({ error: `GitHub API error: ${resp.status}` }, 500)
  }

  const branches = (await resp.json()) as Array<{ name: string }>
  return c.json({ branches: branches.map((b) => b.name) })
})

// POST /api/github/repos/detect-frameworks — batch quick framework detection
router.post('/repos/detect-frameworks', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const db = c.env.DB
  const row = await db
    .prepare('SELECT access_token FROM github_tokens WHERE user_address = ?1')
    .bind(payload.address as string)
    .first<{ access_token: string }>()

  if (!row) {
    return c.json({ error: 'GitHub not connected' }, 401)
  }

  const body = await c.req.json<{ repos: Array<{ owner: string; name: string; branch: string }> }>()
  if (!body.repos || !Array.isArray(body.repos)) {
    return c.json({ error: 'repos array is required' }, 400)
  }

  const results = await quickDetectBatch(row.access_token, body.repos)
  return c.json({ results })
})

export default router
