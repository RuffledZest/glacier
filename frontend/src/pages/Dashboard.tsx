import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { useAuth } from '../hooks/useAuth'
import { listDeployments, type Deployment } from '../lib/api'

const STATUS: Record<string, { color: string; label: string }> = {
  queued:    { color: '#8b949e', label: 'Queued' },
  building:  { color: '#d29922', label: 'Building' },
  built:     { color: '#58a6ff', label: 'Built' },
  deploying: { color: '#d29922', label: 'Deploying' },
  deployed:  { color: '#3fb950', label: 'Live' },
  failed:    { color: '#f85149', label: 'Failed' },
}

function repoDisplay(url: string): string {
  return url.split('/').slice(-2).join('/').replace('.git', '')
}

export default function Dashboard() {
  const { isAuthenticated, login } = useAuth()
  const account = useCurrentAccount()
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isAuthenticated) { setLoading(false); return }
    listDeployments().then(setDeployments).catch(console.error).finally(() => setLoading(false))
    const interval = setInterval(() => {
      listDeployments().then(setDeployments).catch(() => {})
    }, 10000)
    return () => clearInterval(interval)
  }, [isAuthenticated])

  if (!account) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px' }}>
        <h2 style={{ fontSize: 24, fontWeight: 600, color: '#f0f6fc', marginBottom: 12 }}>Connect Wallet</h2>
        <p style={{ color: '#8b949e', marginBottom: 24 }}>Connect your Phantom wallet to view your deployments.</p>
        <ConnectButton connectText="Connect Phantom Wallet" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px' }}>
        <h2 style={{ fontSize: 24, fontWeight: 600, color: '#f0f6fc', marginBottom: 12 }}>Sign In</h2>
        <p style={{ color: '#8b949e', marginBottom: 24 }}>Sign a message with your wallet to continue.</p>
        <button onClick={login} style={{ background: '#238636', color: '#fff', padding: '12px 32px', fontSize: 15, borderRadius: 8 }}>
          Sign In with Wallet
        </button>
      </div>
    )
  }

  const activeDeployments = deployments.filter((d) => d.status !== 'deleted')

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 600, color: '#f0f6fc' }}>Deployments</h2>
        <Link to="/deploy">
          <button style={{ background: '#238636', color: '#fff', padding: '10px 20px', fontSize: 14, fontWeight: 600, borderRadius: 8 }}>
            + New Deploy
          </button>
        </Link>
      </div>

      {loading ? (
        <p style={{ color: '#8b949e', textAlign: 'center', padding: 40 }}>Loading deployments...</p>
      ) : activeDeployments.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📦</div>
          <p style={{ color: '#8b949e', fontSize: 16, marginBottom: 20 }}>No deployments yet.</p>
          <Link to="/deploy">
            <button style={{ background: '#238636', color: '#fff', padding: '12px 28px', fontSize: 15, borderRadius: 8 }}>
              Deploy your first project
            </button>
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activeDeployments.map((d) => {
            const s = STATUS[d.status] || { color: '#8b949e', label: d.status }
            return (
              <Link
                key={d.id}
                to={`/deployments/${d.id}`}
                style={{ textDecoration: 'none' }}
              >
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '16px 20px', background: '#161b22', borderRadius: 10,
                  border: '1px solid #21262d', transition: 'border-color 0.15s',
                }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: '#f0f6fc' }}>
                      {repoDisplay(d.repoUrl)}
                    </div>
                    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4, display: 'flex', gap: 10 }}>
                      <span>{d.branch}</span>
                      <span>·</span>
                      <span>{d.network === 'testnet' ? '🧪 Testnet' : '🌐 Mainnet'}</span>
                      <span>·</span>
                      <span>{new Date(d.createdAt).toLocaleDateString()}</span>
                      {d.base36Url && (
                        <>
                          <span>·</span>
                          <span style={{ color: '#58a6ff', fontFamily: 'monospace', fontSize: 11 }}>{d.base36Url}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    background: `${s.color}20`, color: s.color, textTransform: 'uppercase', letterSpacing: 0.5,
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: s.color,
                      animation: ['building', 'deploying', 'queued'].includes(d.status) ? 'pulse 1.5s infinite' : 'none',
                    }} />
                    {s.label}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
