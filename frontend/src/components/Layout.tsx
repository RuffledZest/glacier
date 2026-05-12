import { Link, useNavigate } from 'react-router-dom'
import { ConnectButton } from '@mysten/dapp-kit'
import { useAuth } from '../hooks/useAuth'
import WalletFooter from './WalletFooter'
import type { ReactNode } from 'react'

export default function Layout({ children }: { children: ReactNode }) {
  const { account, isAuthenticated, logout } = useAuth()
  const navigate = useNavigate()

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 16px' }}>
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 0', borderBottom: '1px solid #21262d', marginBottom: 36,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <Link to="/" style={{ fontSize: 22, fontWeight: 800, color: '#f0f6fc', textDecoration: 'none', letterSpacing: -0.5 }}>
            🧊 Glacier
          </Link>
          {isAuthenticated && (
            <nav style={{ display: 'flex', gap: 20 }}>
              <NavLink to="/dashboard">Dashboard</NavLink>
              <NavLink to="/deploy">Deploy</NavLink>
            </nav>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isAuthenticated ? (
            <>
              <span style={{ fontSize: 12, color: '#8b949e' }}>
                {account?.address?.slice(0, 6)}...{account?.address?.slice(-4)}
              </span>
              <button
                onClick={() => { logout(); navigate('/') }}
                style={{
                  background: '#21262d', color: '#c9d1d9', fontSize: 12, fontWeight: 500,
                  border: '1px solid #30363d', borderRadius: 6, padding: '6px 14px',
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <ConnectButton connectText="Connect Wallet" />
          )}
        </div>
      </header>

      <main>{children}</main>

      <WalletFooter />
    </div>
  )
}

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  const isActive = typeof window !== 'undefined' && window.location.pathname === to
  return (
    <Link
      to={to}
      style={{
        fontSize: 14, fontWeight: isActive ? 600 : 400,
        color: isActive ? '#f0f6fc' : '#8b949e',
        textDecoration: 'none', transition: 'color 0.15s',
      }}
    >
      {children}
    </Link>
  )
}
