import { sign, verify } from 'hono/jwt'

export async function createJwt(address: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: address,
    address,
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

export function generateNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function buildSignMessage(nonce: string): string {
  return `Sign this message to authenticate with Glacier.\n\nNonce: ${nonce}`
}
