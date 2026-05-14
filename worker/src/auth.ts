import { sign, verify } from 'hono/jwt'

export interface SessionJwtInput {
  userId: string
  githubLogin: string
}

export async function createSessionJwt(input: SessionJwtInput, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: input.userId,
    address: input.userId,
    github_login: input.githubLogin,
    iat: now,
    exp: now + 86400, // 24 hours
  }
  return sign(payload as Record<string, unknown>, secret)
}

export async function verifyJwt(token: string, secret: string) {
  try {
    const payload = await verify(token, secret, 'HS256')
    return payload
  } catch {
    return null
  }
}

/** Short-lived signed state for GitHub OAuth CSRF protection. */
export async function createOAuthStateToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    { purpose: 'github_oauth_state', iat: now, exp: now + 600 },
    secret,
    'HS256'
  )
}

export async function verifyOAuthStateToken(token: string, secret: string): Promise<boolean> {
  const payload = await verifyJwt(token, secret)
  if (!payload || typeof payload !== 'object') return false
  return (payload as Record<string, unknown>).purpose === 'github_oauth_state'
}
