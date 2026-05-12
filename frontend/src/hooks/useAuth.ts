import { useState, useCallback } from 'react'
import { useCurrentAccount, useSignPersonalMessage } from '@mysten/dapp-kit'
import { getNonce, verifySignature, setToken, clearToken, getToken } from '../lib/api'

export function useAuth() {
  const account = useCurrentAccount()
  const { mutateAsync: signMessage } = useSignPersonalMessage()
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const token = getToken()
  const isAuthenticated = !!token && !!account

  const login = useCallback(async () => {
    if (!account) {
      setError('Please connect your wallet first')
      return false
    }

    setIsConnecting(true)
    setError(null)

    try {
      const { nonce, message } = await getNonce(account.address)

      const result = await signMessage({
        message: new TextEncoder().encode(message),
      })

      if (!result.signature) {
        throw new Error('No signature returned from wallet')
      }

      const { token } = await verifySignature(account.address, message, result.signature)
      setToken(token)
      setIsConnecting(false)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed'
      setError(message)
      setIsConnecting(false)
      return false
    }
  }, [account, signMessage])

  const logout = useCallback(() => {
    clearToken()
  }, [])

  return {
    account,
    isAuthenticated,
    isConnecting,
    error,
    login,
    logout,
  }
}
