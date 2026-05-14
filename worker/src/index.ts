import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Container } from '@cloudflare/containers'
import { BuildContainer } from './container'
import { verifyJwt } from './auth'
import deploy from './routes/deploy'
import webhook from './routes/webhook'
import github from './routes/github'
import wallet from './routes/wallet'
import estimate from './routes/estimate'

export { BuildContainer }

export interface Env {
  DB: D1Database
  BUILD_CONTAINER: DurableObjectNamespace<Container>
  JWT_SECRET: string
  GITHUB_TOKEN?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** Full callback URL registered in the GitHub OAuth app (e.g. https://api.example.com/api/github/callback) */
  GITHUB_REDIRECT_URI?: string
  /** Worker public origin if GITHUB_REDIRECT_URI is omitted (callback becomes {API_PUBLIC_URL}/api/github/callback) */
  API_PUBLIC_URL?: string
  /** Frontend origin for post-login redirect (e.g. https://app.example.com) */
  FRONTEND_URL?: string
  WEBHOOK_SECRET?: string
  SUI_KEYSTORE?: string
  SUI_ADDRESS?: string
  WALRUS_NETWORK?: string
  WALRUS_EPOCHS?: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

app.get('/api/me', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }
  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }
  const rec = payload as Record<string, unknown>
  return c.json({
    user_id: rec.address as string,
    github_login: (rec.github_login as string | undefined) ?? null,
  })
})

app.route('/api', deploy)
app.route('/api/webhook', webhook)
app.route('/api/github', github)
app.route('/api', wallet)
app.route('/api', estimate)

app.get('/health', (c) => c.json({ ok: true }))

export default app
