import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { getDeployment, deleteDeployment, retryDeployment, getToken, type Deployment } from '../lib/api'
import { ansiToHtml } from '../lib/ansi'
import { useSSE } from '../hooks/useSSE'
import { Button } from '../components/ui/Button'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Spinner } from '../components/ui/Spinner'
import {
  ArrowLeft, ExternalLink, GitBranch, Globe, Terminal, Trash2, RotateCcw,
  Clock, CheckCircle2, XCircle, AlertCircle, Calendar, Hash, FolderOutput, Code2, Database, LayoutDashboard
} from 'lucide-react'
import { cn } from '../lib/utils'

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
  building:  { color: 'warning', label: 'Building', icon: <Spinner className="w-3 h-3" /> },
  built:     { color: 'info', label: 'Built', icon: <CheckCircle2 className="w-3 h-3" /> },
  deploying: { color: 'warning', label: 'Deploying', icon: <Spinner className="w-3 h-3" /> },
  deployed:  { color: 'success', label: 'Live', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:    { color: 'danger', label: 'Failed', icon: <XCircle className="w-3 h-3" /> },
}

function repoDisplay(url: string): string {
  return url.split('/').slice(-2).join('/').replace('.git', '')
}

export default function DeploymentDetail() {
  const { id } = useParams<{ id: string }>()
  const { isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const [d, setD] = useState<Deployment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [liveLogs, setLiveLogs] = useState('')
  const [sseDone, setSseDone] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const isLive = !!(d && ['building', 'deploying'].includes(d.status))
  const hasError = !!(d && d.status === 'failed')

  // Reset local state when switching deployments
  useEffect(() => {
    setLiveLogs('')
    setSseDone(false)
    setLoading(true)
  }, [id])

  // SSE only during active build
  useSSE({
    url: isLive ? `${import.meta.env.VITE_API_BASE || '/api'}/deployments/${id}/logs` : '',
    token: getToken() || '',
    onMessage: (text) => {
      setLiveLogs((prev) => {
        const next = prev + text
        // Keep only last 100K chars to prevent memory issues
        return next.length > 100_000 ? next.slice(-100_000) : next
      })
    },
    onDone: () => {
      setSseDone(true)
      // Refresh final state from D1 with retries — worker may still be writing logs
      if (id) {
        let attempts = 0
        const fetchWithRetry = async () => {
          try {
            const dep = await getDeployment(id)
            setD(dep)
            // If worker hasn't finished writing final logs yet, retry
            if (['building', 'built', 'deploying'].includes(dep.status) && attempts < 5) {
              attempts++
              setTimeout(fetchWithRetry, 1500)
            }
          } catch {}
        }
        fetchWithRetry()
      }
    },
  })

  // Auto-scroll logs
  useEffect(() => {
    if (liveLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveLogs])

  // Status polling during all active phases
  useEffect(() => {
    if (!id || !isAuthenticated) return
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const dep = await getDeployment(id)
        setD(dep)
        setError(null)
        if (['queued', 'building', 'built', 'deploying'].includes(dep.status)) {
          timer = setTimeout(poll, 3000)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    }
    poll()
    return () => clearTimeout(timer)
  }, [id, isAuthenticated])

  async function handleDelete() {
    if (!id || !confirm('Delete this deployment? This cannot be undone.')) return
    setDeleting(true)
    try { await deleteDeployment(id); navigate('/dashboard') }
    catch (err) { alert(err instanceof Error ? err.message : 'Delete failed'); setDeleting(false) }
  }

  async function handleRetry() {
    if (!id) return
    setRetrying(true)
    try {
      const { id: newId } = await retryDeployment(id)
      navigate(`/deployments/${newId}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Retry failed')
      setRetrying(false)
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="w-12 h-12 text-warning mb-4" />
        <h2 className="text-xl font-semibold mb-2">Authentication Required</h2>
        <p className="text-textMuted mb-6">Please sign in to view this deployment.</p>
        <Link to="/dashboard">
          <Button>Go to Dashboard</Button>
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Spinner className="w-8 h-8 text-primary mb-4" />
        <p className="text-textMuted font-medium">Loading deployment details...</p>
      </div>
    )
  }

  if (error || !d) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <XCircle className="w-12 h-12 text-danger mb-4" />
        <h2 className="text-xl font-semibold mb-2 text-danger">Deployment Not Found</h2>
        <p className="text-textMuted mb-6">{error || 'The deployment you are looking for does not exist.'}</p>
        <Link to="/dashboard">
          <Button variant="secondary">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
          </Button>
        </Link>
      </div>
    )
  }

  const s = STATUS[d.status] || STATUS.queued

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Top Nav */}
      <div className="flex items-center gap-4">
        <Link 
          to="/dashboard" 
          className="p-2 -ml-2 rounded-lg hover:bg-surface text-textMuted hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex items-center gap-2 text-sm font-medium text-textMuted">
          <LayoutDashboard className="w-4 h-4" />
          <Link to="/dashboard" className="hover:text-white transition-colors">Deployments</Link>
          <span className="text-border">/</span>
          <span className="text-white truncate max-w-[200px]">{repoDisplay(d.repoUrl)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (Main Content) */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Header Card */}
          <Card className="border-border">
            <div className="p-6">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight text-white mb-2 flex items-center gap-3">
                    <GithubIcon className="w-6 h-6" />
                    {repoDisplay(d.repoUrl)}
                  </h1>
                  <div className="flex items-center gap-4 text-sm text-textMuted">
                    <span className="flex items-center gap-1.5"><GitBranch className="w-4 h-4" /> {d.branch}</span>
                    <span className="flex items-center gap-1.5"><Globe className="w-4 h-4" /> {d.network === 'testnet' ? 'Testnet' : 'Mainnet'}</span>
                  </div>
                </div>
                <Badge variant={s.color} className="text-sm py-1 px-3 gap-2 uppercase tracking-widest font-bold">
                  {s.icon} {s.label}
                </Badge>
              </div>

              {/* Success Box */}
              {d.status === 'deployed' && d.base36Url && (
                <div className="mt-6 bg-success/10 border border-success/30 rounded-xl p-5">
                  <div className="text-xs font-semibold text-success uppercase tracking-wider mb-2">Live URL</div>
                  <a
                    href={`https://${d.base36Url}.wal.app`}
                    target="_blank" rel="noopener noreferrer"
                    className="group inline-flex items-center gap-2 text-xl font-bold text-success hover:text-success/80 transition-colors break-all"
                  >
                    {d.base36Url}.wal.app
                    <ExternalLink className="w-5 h-5 opacity-50 group-hover:opacity-100 transition-opacity" />
                  </a>
                </div>
              )}

              {/* Error Box */}
              {d.error && (
                <div className="mt-6 bg-danger/10 border border-danger/30 rounded-xl p-5">
                  <div className="flex items-center gap-2 text-danger font-semibold mb-2">
                    <XCircle className="w-5 h-5" /> Build Failed
                  </div>
                  <pre className="text-sm text-danger/90 font-mono whitespace-pre-wrap break-words">{d.error}</pre>
                </div>
              )}
            </div>

            {/* Quick Actions Footer */}
            <div className="bg-surface/50 border-t border-border px-6 py-4 flex items-center justify-end gap-3 rounded-b-xl">
              {d.status === 'failed' && (
                <Button variant="primary" onClick={handleRetry} disabled={retrying}>
                  {retrying ? <Spinner className="mr-2" /> : <RotateCcw className="w-4 h-4 mr-2" />}
                  {retrying ? 'Retrying...' : 'Retry Build'}
                </Button>
              )}
              <Button variant="danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? <Spinner className="mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                {deleting ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </Card>

          {/* Terminal / Logs */}
          <Card className="border-border overflow-hidden bg-black flex flex-col min-h-[400px]">
            <div className="bg-surface border-b border-border px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-textMuted">
                <Terminal className="w-4 h-4" /> Build Logs
              </div>
              {isLive && (
                <div className="flex items-center gap-2 text-xs font-medium text-warning bg-warning/10 px-2.5 py-1 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-warning animate-pulse"></span>
                  Live
                </div>
              )}
            </div>
            <div className="flex-1 p-4 overflow-x-auto overflow-y-auto max-h-[600px] font-mono text-sm leading-relaxed scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
              <pre
                dangerouslySetInnerHTML={{
                  __html: ansiToHtml(liveLogs || d.logs || 'Waiting for logs...'),
                }}
                className="text-textMuted"
              />
              <div ref={logsEndRef} className="h-4" />
            </div>
          </Card>
        </div>

        {/* Right Column (Metadata) */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-4 border-b border-border/50">
              <CardTitle className="text-sm flex items-center gap-2 text-textMuted">
                <Database className="w-4 h-4" /> Deployment Details
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-6">
              
              <div className="space-y-4">
                <DetailRow icon={<Hash className="w-4 h-4" />} label="Deployment ID" value={d.id.slice(0, 8) + '...'} />
                <DetailRow icon={<Calendar className="w-4 h-4" />} label="Created At" value={new Date(d.createdAt).toLocaleString()} />
                <DetailRow icon={<Clock className="w-4 h-4" />} label="Updated At" value={new Date(d.updatedAt).toLocaleString()} />
              </div>

              <div className="h-px bg-border/50 w-full" />

              <div className="space-y-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-textMuted mb-2">Build Config</h4>
                <DetailRow icon={<Code2 className="w-4 h-4" />} label="Install Cmd" value={d.installCommand || 'auto'} />
                <DetailRow icon={<Terminal className="w-4 h-4" />} label="Build Cmd" value={d.buildCommand || 'auto'} />
                <DetailRow icon={<FolderOutput className="w-4 h-4" />} label="Output Dir" value={d.outputDir || 'auto'} />
                <DetailRow icon={<FolderOutput className="w-4 h-4" />} label="Base Dir" value={d.baseDir || '.'} />
              </div>

              {d.objectId && (
                <>
                  <div className="h-px bg-border/50 w-full" />
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-textMuted">Storage Details</h4>
                    <div className="text-xs font-mono text-info break-all bg-info/10 p-2 rounded border border-info/20">
                      ID: {d.objectId}
                    </div>
                  </div>
                </>
              )}

            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-textMuted text-sm">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium text-white truncate max-w-[150px]" title={value}>
        {value}
      </div>
    </div>
  )
}
