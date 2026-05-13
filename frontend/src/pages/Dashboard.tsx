import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { useAuth } from '../hooks/useAuth'
import { listDeployments, type Deployment } from '../lib/api'
import { encodeRepoUrl, repoDisplay } from '../lib/repos'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import {   Plus, Box, GitBranch, Globe, Clock, Wallet, CheckCircle2, XCircle, Loader2, AlertCircle, ExternalLink } from 'lucide-react'

const STATUS: Record<string, { color: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string; icon: React.ReactNode }> = {
  queued:    { color: 'default', label: 'Queued', icon: <Clock className="w-3 h-3" /> },
  building:  { color: 'warning', label: 'Building', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  built:     { color: 'info', label: 'Built', icon: <CheckCircle2 className="w-3 h-3" /> },
  deploying: { color: 'warning', label: 'Deploying', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  deployed:  { color: 'success', label: 'Live', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:    { color: 'danger', label: 'Failed', icon: <XCircle className="w-3 h-3" /> },
}

interface Project {
  repoUrl: string
  name: string
  deployments: Deployment[]
  latest: Deployment | null
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

  const projects = useMemo<Project[]>(() => {
    const groups = new Map<string, Deployment[]>()
    for (const d of deployments) {
      if (d.status === 'deleted') continue
      const existing = groups.get(d.repoUrl) || []
      existing.push(d)
      groups.set(d.repoUrl, existing)
    }

    const result: Project[] = []
    for (const [repoUrl, deps] of groups) {
      deps.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      result.push({
        repoUrl,
        name: repoDisplay(repoUrl),
        deployments: deps,
        latest: deps[0] || null,
      })
    }
    // Sort projects by latest deployment date
    result.sort((a, b) => {
      const da = a.latest ? +new Date(a.latest.createdAt) : 0
      const db = b.latest ? +new Date(b.latest.createdAt) : 0
      return db - da
    })
    return result
  }, [deployments])

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <div className="w-16 h-16 bg-surface border border-border rounded-2xl flex items-center justify-center mb-6 shadow-sm">
          <Wallet className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold text-white mb-3">Connect Wallet</h2>
        <p className="text-textMuted mb-8 text-center max-w-md">
          Connect your Phantom wallet to view your projects and deployments.
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

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-2xl font-bold text-white tracking-tight">Projects</h2>
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
          <p className="text-textMuted font-medium">Loading projects...</p>
        </div>
      ) : projects.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl flex flex-col items-center justify-center py-24 px-4 bg-surface/30">
          <Box className="w-12 h-12 text-textMuted mb-4" />
          <h3 className="text-lg font-semibold text-white mb-2">No projects yet</h3>
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
        <div className="grid gap-4">
          {projects.map((project) => {
            const latest = project.latest
            const s = latest ? STATUS[latest.status] || STATUS.queued : STATUS.queued
            const total = project.deployments.length
            const liveCount = project.deployments.filter((d) => d.status === 'deployed').length
            const failedCount = project.deployments.filter((d) => d.status === 'failed').length

            return (
              <Link
                key={project.repoUrl}
                to={`/projects/${encodeRepoUrl(project.repoUrl)}`}
                className="group block p-5 bg-surface rounded-xl border border-border hover:border-primary/50 transition-all hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-semibold text-white group-hover:text-primary transition-colors">
                        {project.name}
                      </span>
                      <Badge variant={s.color} className="gap-1.5 uppercase tracking-wider text-[10px]">
                        {s.icon} {s.label}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-4 text-xs font-medium text-textMuted">
                      {latest && (
                        <>
                          <div className="flex items-center gap-1.5">
                            <GitBranch className="w-3.5 h-3.5" />
                            {latest.branch}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Globe className="w-3.5 h-3.5" />
                            {latest.network === 'testnet' ? 'Testnet' : 'Mainnet'}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5" />
                            {new Date(latest.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="bg-surface px-2 py-0.5 rounded border border-border">{total} deploy{total !== 1 ? 's' : ''}</span>
                        {liveCount > 0 && <span className="bg-success/10 text-success px-2 py-0.5 rounded border border-success/20">{liveCount} live</span>}
                        {failedCount > 0 && <span className="bg-danger/10 text-danger px-2 py-0.5 rounded border border-danger/20">{failedCount} failed</span>}
                      </div>
                    </div>

                    {latest?.base36Url && (
                      <div className="flex items-center gap-1.5 text-info text-xs">
                        <ExternalLink className="w-3 h-3" />
                        <span className="font-mono">{latest.base36Url}.wal.app</span>
                      </div>
                    )}
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
