import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { useAuth } from '../hooks/useAuth'
import { listDeployments, type Deployment } from '../lib/api'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Plus, Box, GitBranch, Globe, Clock, Wallet, CheckCircle2, XCircle, Loader2, AlertCircle } from 'lucide-react'

const STATUS: Record<string, { color: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string; icon: React.ReactNode }> = {
  queued:    { color: 'default', label: 'Queued', icon: <Clock className="w-3 h-3" /> },
  building:  { color: 'warning', label: 'Building', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  built:     { color: 'info', label: 'Built', icon: <CheckCircle2 className="w-3 h-3" /> },
  deploying: { color: 'warning', label: 'Deploying', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  deployed:  { color: 'success', label: 'Live', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:    { color: 'danger', label: 'Failed', icon: <XCircle className="w-3 h-3" /> },
}

function repoDisplay(url: string): string {
  return url.split('/').slice(-2).join('/').replace('.git', '')
}

export default function Dashboard() {
  const { isAuthenticated, login, isConnecting } = useAuth()
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
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <div className="w-16 h-16 bg-surface border border-border rounded-2xl flex items-center justify-center mb-6 shadow-sm">
          <Wallet className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold text-white mb-3">Connect Wallet</h2>
        <p className="text-textMuted mb-8 text-center max-w-md">
          Connect your Phantom wallet to view your deployments and manage your projects.
        </p>
        <ConnectButton />
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <div className="w-16 h-16 bg-surface border border-border rounded-2xl flex items-center justify-center mb-6 shadow-sm">
          <ShieldCheck className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold text-white mb-3">Sign In</h2>
        <p className="text-textMuted mb-8 text-center max-w-md">
          Sign a message with your wallet to authenticate and view your dashboard.
        </p>
        <Button onClick={login} disabled={isConnecting} size="lg" className="px-8 shadow-lg shadow-primary/20">
          {isConnecting ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null}
          {isConnecting ? 'Signing In...' : 'Sign In with Wallet'}
        </Button>
      </div>
    )
  }

  const activeDeployments = deployments.filter((d) => d.status !== 'deleted')

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold text-white tracking-tight">Deployments</h2>
        <Link to="/deploy">
          <Button className="shadow-sm">
            <Plus className="w-4 h-4 mr-2" />
            New Deploy
          </Button>
        </Link>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-primary animate-spin mb-4" />
          <p className="text-textMuted font-medium">Loading deployments...</p>
        </div>
      ) : activeDeployments.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl flex flex-col items-center justify-center py-24 px-4 bg-surface/30">
          <Box className="w-12 h-12 text-textMuted mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">No deployments yet</h3>
          <p className="text-textMuted mb-6 text-center max-w-sm">
            You haven't deployed any projects yet. Connect your GitHub and ship your first site.
          </p>
          <Link to="/deploy">
            <Button>
              Deploy your first project
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-3">
          {activeDeployments.map((d) => {
            const s = STATUS[d.status] || STATUS.queued
            return (
              <Link
                key={d.id}
                to={`/deployments/${d.id}`}
                className="group block p-4 bg-surface rounded-xl border border-border hover:border-primary/50 transition-all hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-semibold text-white group-hover:text-primary transition-colors">
                        {repoDisplay(d.repoUrl)}
                      </span>
                      <Badge variant={s.color} className="gap-1.5 uppercase tracking-wider text-[10px]">
                        {s.icon}
                        {s.label}
                      </Badge>
                    </div>
                    
                    <div className="flex items-center gap-4 text-xs font-medium text-textMuted">
                      <div className="flex items-center gap-1.5">
                        <GitBranch className="w-3.5 h-3.5" />
                        {d.branch}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Globe className="w-3.5 h-3.5" />
                        {d.network === 'testnet' ? 'Testnet' : 'Mainnet'}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        {new Date(d.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                      {d.base36Url && (
                        <div className="flex items-center gap-1.5 text-info ml-2 bg-info/10 px-2 py-0.5 rounded-md">
                          <span className="font-mono">{d.base36Url}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="text-textMuted group-hover:text-white transition-colors">
                    <AlertCircle className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ShieldCheck(props: any) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>
}
