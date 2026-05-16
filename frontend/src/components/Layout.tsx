import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import WalletFooter from './WalletFooter'
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import { Box } from 'lucide-react'
import { Button } from './ui/Button'

export default function Layout({ children }: { children: ReactNode }) {
  const { isAuthenticated, githubLogin, logout, login, isConnecting } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  if (location.pathname === '/') {
    return <>{children}</>
  }

  return (
    <div className="min-h-screen flex flex-col max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <header className="flex items-center justify-between py-6 border-b border-border mb-8">
        <div className="flex items-center gap-8">
          <Link to="/" className="flex items-center gap-2 text-2xl font-bold text-text hover:text-white transition-colors">
            <Box className="w-8 h-8 text-primary" />
            <span className="tracking-tight">Glacier</span>
          </Link>

          {isAuthenticated && (
            <nav className="hidden md:flex gap-6">
              <NavLink to="/dashboard">Dashboard</NavLink>
              <NavLink to="/deploy">Deploy</NavLink>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-4">
          {isAuthenticated ? (
            <div className="flex items-center gap-3 bg-surface px-3 py-1.5 rounded-full border border-border">
              <div className="w-2 h-2 rounded-full bg-success"></div>
              <span className="text-sm font-medium text-textMuted">
                {githubLogin ?? 'GitHub'}
              </span>
              <div className="w-px h-4 bg-border mx-1"></div>
              <button
                type="button"
                onClick={() => {
                  logout()
                  navigate('/')
                }}
                className="text-sm font-medium text-textMuted hover:text-text transition-colors"
              >
                Sign out
              </button>
            </div>
          ) : (
            <Button type="button" onClick={() => void login()} disabled={isConnecting} size="sm">
              {isConnecting ? 'Redirecting…' : 'Sign in with GitHub'}
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1 w-full">{children}</main>

      <WalletFooter />
    </div>
  )
}

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  const location = useLocation()
  const isActive = location.pathname === to
  return (
    <Link
      to={to}
      className={cn(
        'text-sm font-medium transition-colors hover:text-white',
        isActive ? 'text-white' : 'text-textMuted'
      )}
    >
      {children}
    </Link>
  )
}
