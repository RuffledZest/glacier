import { Hono } from 'hono'
import type { Env } from '..'
import { verifyJwt } from '../auth'
import {
  getOAuthUrl,
  exchangeCode,
  listRepos,
  listContents,
  detectProjects,
  quickDetectBatch,
} from '../github-api'

const router = new Hono<{ Bindings: Env }>()

// GET /api/github/auth — returns OAuth URL to redirect to
router.get('/auth', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const clientId = c.env.GITHUB_CLIENT_ID
  if (!clientId) {
    return c.json({ error: 'GitHub OAuth not configured on server' }, 500)
  }

  const redirectUri = `https://glacier.construct-computer.workers.dev/api/github/callback`
  const url = getOAuthUrl(clientId, redirectUri)

  return c.json({ url })
})

// GET /api/github/callback — handle OAuth redirect from GitHub
router.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')

  if (!code) {
    return c.json({ error: 'missing code parameter' }, 400)
  }

  const clientId = c.env.GITHUB_CLIENT_ID
  const clientSecret = c.env.GITHUB_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return c.json({ error: 'GitHub OAuth not configured on server' }, 500)
  }

  try {
    const { access_token, github_user } = await exchangeCode(code, clientId, clientSecret)

    // At this point we have the GitHub token but no user context.
    // We need the user to be authenticated with Phantom too.
    // We'll pass the token via query param to the frontend, which will
    // then send it with the Phantom JWT to complete the linking.

    return c.redirect(
      `https://glacier-frontend.pages.dev/deploy?token=${encodeURIComponent(access_token)}&gh_user=${encodeURIComponent(github_user || '')}`
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth failed'
    return c.json({ error: message }, 500)
  }
})

// GET /api/github/link — frontend calls this with Phantom JWT + GitHub token to store
router.get('/link', async (c) => {
  // This is called after the redirect from callback.
  // The frontend intercepts the redirect and calls this with the Phantom JWT.
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const jwt = authHeader.slice(7)
  const payload = await verifyJwt(jwt, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const githubToken = c.req.query('token')
  const githubUser = c.req.query('gh_user') || null

  if (!githubToken) {
    return c.json({ error: 'missing GitHub token' }, 400)
  }

  // Store token in D1
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
    .bind(payload.address as string, githubToken, githubUser)
    .run()

  return c.json({ ok: true, github_user: githubUser })
})

// GET /api/github/status — check if user has connected GitHub
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
        'User-Agent': 'glacier',
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
