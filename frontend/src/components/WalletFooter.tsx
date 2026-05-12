import { useEffect, useState } from 'react'

interface WalletInfo {
  address: string | null
  message?: string
  testnet: { sui: string; wal: string }
  mainnet: { sui: string; wal: string }
}

function fmtMist(balance: string): string {
  const n = Number(balance) / 1e9
  if (n === 0) return '0'
  if (n < 0.001) return '<0.001'
  if (n < 1) return n.toFixed(3)
  if (n < 1000) return n.toFixed(2)
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function WalletFooter() {
  const [info, setInfo] = useState<WalletInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchWallet = () => {
      const base = import.meta.env.VITE_API_BASE || '/api'
      fetch(`${base}/wallet?t=${Date.now()}`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setInfo(d) })
        .catch(() => {})
    }
    fetchWallet()
    const i = setInterval(fetchWallet, 30000)
    return () => { cancelled = true; clearInterval(i) }
  }, [])

  if (!info || !info.address) return null

  return (
    <footer style={{
      marginTop: 48, padding: '14px 0', borderTop: '1px solid #21262d',
      fontSize: 11, color: '#484f58', display: 'flex', gap: 24,
      flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{ color: '#8b949e', fontWeight: 500 }}>
        Deploy Wallet
      </span>
      <a
        href={`https://suiscan.xyz/testnet/account/${info.address}`}
        target="_blank" rel="noopener noreferrer"
        style={{ color: '#58a6ff', fontFamily: 'monospace' }}
        title={info.address}
      >
        {shortAddr(info.address)}
      </a>

      <span style={{ color: '#30363d' }}>|</span>

      <span>
        <span style={{ color: '#d29922' }}>🧪</span>{' '}
        {fmtMist(info.testnet.sui)} SUI
        {Number(info.testnet.wal) > 0 && (
          <span style={{ marginLeft: 6 }}>{fmtMist(info.testnet.wal)} WAL</span>
        )}
      </span>

      <span style={{ color: '#30363d' }}>|</span>

      <span>
        <span style={{ color: '#3fb950' }}>🌐</span>{' '}
        {fmtMist(info.mainnet.sui)} SUI
        {Number(info.mainnet.wal) > 0 && (
          <span style={{ marginLeft: 6 }}>{fmtMist(info.mainnet.wal)} WAL</span>
        )}
      </span>
    </footer>
  )
}
