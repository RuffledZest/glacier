import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { listDeployments, type Deployment } from '../lib/api'
import { encodeRepoUrl, repoDisplay } from '../lib/repos'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Plus, Box, GitBranch, Globe, Clock, Loader2, AlertCircle, ExternalLink, CheckCircle2, XCircle, Hash } from 'lucide-react'

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
      <path d="M9 18c-4.51 2-5-2-7-2"/>
    </svg>
  )
}

const STATUS: Record<string, { color: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string; icon: React.ReactNode }> = {
  queued:    { color: 'default', label: 'Queued', icon: <Clock className="w-3 h-3" /> },
  building:  { color: 'warning', label: 'Building', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  built:     { color: 'info', label: 'Built', icon: <CheckCircle2 className="w-3 h-3" /> },
  deploying: { color: 'warning', label: 'Deploying', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  deployed:  { color: 'success', label: 'Live', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:    { color: 'danger', label: 'Failed', icon: <XCircle className="w-3 h-3" /> },
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown'
}

interface Project {
  repoUrl: string
  name: string
  deployments: Deployment[]
  latest: Deployment | null
}

export default function Dashboard() {
  const { isAuthenticated, login, isConnecting } = useAuth()
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
    result.sort((a, b) => {
      const da = a.latest ? +new Date(a.latest.createdAt) : 0
      const db = b.latest ? +new Date(b.latest.createdAt) : 0
      return db - da
    })
    return result
  }, [deployments])

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <div className="w-16 h-16 bg-surface border border-border rounded-2xl flex items-center justify-center mb-6 shadow-sm">
          <GithubIcon className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-semibold text-white mb-3">Sign in</h2>
        <p className="text-textMuted mb-8 text-center max-w-md">
          Sign in with GitHub to view your projects and deployments.
        </p>
        <Button onClick={() => void login()} disabled={isConnecting} size="lg" className="px-8 shadow-lg shadow-primary/20">
          {isConnecting ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null}
          {isConnecting ? 'Redirecting…' : 'Sign in with GitHub'}
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
            You haven&apos;t deployed any projects yet. Connect your GitHub and ship your first site.
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
                          <div className="flex items-center gap-1.5" title={latest.commitMessage || undefined}>
                            <Hash className="w-3.5 h-3.5" />
                            {shortSha(latest.commitSha)}
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
