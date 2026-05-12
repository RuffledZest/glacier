import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Container } from '@cloudflare/containers'
import { BuildContainer } from './container'
import auth from './routes/auth'
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

app.route('/api/auth', auth)
app.route('/api', deploy)
app.route('/api/webhook', webhook)
app.route('/api/github', github)
app.route('/api', wallet)
app.route('/api', estimate)

app.get('/health', (c) => c.json({ ok: true }))

export default app
