import { Hono } from 'hono'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import type { Env } from '..'
import { generateNonce, buildSignMessage, createJwt } from '../auth'

const router = new Hono<{ Bindings: Env }>()

router.get('/nonce', (c) => {
  const address = c.req.query('address')
  if (!address) {
    return c.json({ error: 'address query parameter required' }, 400)
  }

  if (!address.startsWith('0x') || address.length !== 66) {
    return c.json({ error: 'invalid Sui address format' }, 400)
  }

  const nonce = generateNonce()
  const message = buildSignMessage(nonce)

  return c.json({ nonce, message })
})

router.post('/verify', async (c) => {
  const body = await c.req.json<{
    address: string
    message: string
    signature: string
  }>()

  const { address, message, signature } = body

  if (!address || !message || !signature) {
    return c.json({ error: 'address, message, and signature are required' }, 400)
  }

  if (!address.startsWith('0x') || address.length !== 66) {
    return c.json({ error: 'invalid Sui address format' }, 400)
  }

  if (!message.startsWith('Sign this message to authenticate with Glacier')) {
    return c.json({ error: 'invalid message format' }, 400)
  }

  try {
    const publicKey = await verifyPersonalMessageSignature(
      new TextEncoder().encode(message),
      signature
    )

    if (!publicKey) {
      return c.json({ error: 'signature verification failed' }, 401)
    }

    const jwtSecret = c.env.JWT_SECRET
    if (!jwtSecret) {
      return c.json({ error: 'server misconfigured' }, 500)
    }

    const token = await createJwt(address, jwtSecret)

    return c.json({ token, address })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'verification failed'
    return c.json({ error: errorMessage }, 401)
  }
})

export default router
