import { Hono } from 'hono'
import type { Env } from '..'

const router = new Hono<{ Bindings: Env }>()

interface CoinBalance {
  coinType: string
  coinObjectCount: number
  totalBalance: string
}

interface RpcResponse {
  jsonrpc: string
  id: number
  result?: CoinBalance[] | { coinType: string; totalBalance: string }
  error?: { code: number; message: string }
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<RpcResponse> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return resp.json() as Promise<RpcResponse>
}

const TESTNET_RPC = 'https://fullnode.testnet.sui.io:443'
const MAINNET_RPC = 'https://fullnode.mainnet.sui.io:443'

router.get('/wallet', async (c) => {
  const address = c.env.SUI_ADDRESS

  if (!address) {
    return c.json({
      address: null,
      message: 'no wallet configured',
    })
  }

  const results: Record<string, unknown> = {
    address,
    testnet: { sui: '0', wal: '0' },
    mainnet: { sui: '0', wal: '0' },
  }

  // Query both networks in parallel
  const [testnetSui, mainnetSui, testnetBal, mainnetBal] = await Promise.allSettled([
    rpcCall(TESTNET_RPC, 'suix_getBalance', [address]),
    rpcCall(MAINNET_RPC, 'suix_getBalance', [address]),
    rpcCall(TESTNET_RPC, 'suix_getAllBalances', [address]),
    rpcCall(MAINNET_RPC, 'suix_getAllBalances', [address]),
  ])

  // Parse SUI balances
  if (testnetSui.status === 'fulfilled' && testnetSui.value?.result && !testnetSui.value.error) {
    const r = testnetSui.value.result as { totalBalance: string }
    results.testnet = { ...results.testnet as Record<string, string>, sui: r.totalBalance }
  }
  if (mainnetSui.status === 'fulfilled' && mainnetSui.value?.result && !mainnetSui.value.error) {
    const r = mainnetSui.value.result as { totalBalance: string }
    results.mainnet = { ...results.mainnet as Record<string, string>, sui: r.totalBalance }
  }

  // Parse WAL balances (filter all coins for WAL type)
  if (testnetBal.status === 'fulfilled' && testnetBal.value?.result && !testnetBal.value.error) {
    const coins = testnetBal.value.result as CoinBalance[]
    const wal = coins.find((c) => c.coinType.toLowerCase().includes('::wal::'))
    if (wal) {
      results.testnet = { ...results.testnet as Record<string, string>, wal: wal.totalBalance }
    }
  }
  if (mainnetBal.status === 'fulfilled' && mainnetBal.value?.result && !mainnetBal.value.error) {
    const coins = mainnetBal.value.result as CoinBalance[]
    const wal = coins.find((c) => c.coinType.toLowerCase().includes('::wal::'))
    if (wal) {
      results.mainnet = { ...results.mainnet as Record<string, string>, wal: wal.totalBalance }
    }
  }

  return c.json(results)
})

export default router
