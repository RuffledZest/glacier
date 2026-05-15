import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import {
  getProject,
  deleteProject,
  listProjects,
  listDeployments,
  listProjectSecrets,
  rotateProjectSecret,
  importProjectSecrets,
  deleteProjectSecret,
  type Project,
  type Deployment,
  type ProjectSecret,
} from '../lib/api'
import { decodeRepoUrl, repoDisplay, encodeRepoUrl } from '../lib/repos'
import {
  approxWalStorageEndDate,
  walrusRetentionCalendarDays,
  MAINNET_DAYS_PER_EPOCH,
} from '../lib/epochs'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Spinner } from '../components/ui/Spinner'
import {
  ArrowLeft, ExternalLink, GitBranch, Globe, Terminal,
  Clock, CheckCircle2, XCircle, AlertCircle, Calendar,
  Hash, FolderOutput, Code2, Database, LayoutDashboard, Trash2,
  KeyRound, Plus, RefreshCcw, Upload
} from 'lucide-react'
import { cn } from '../lib/utils'

const STATUS: Record<string, { color: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string; icon: React.ReactNode }> = {
  queued:    { color: 'default', label: 'Queued', icon: <Clock className="w-3 h-3" /> },
  building:  { color: 'warning', label: 'Building', icon: <Spinner className="w-3 h-3" /> },
  built:     { color: 'info', label: 'Built', icon: <CheckCircle2 className="w-3 h-3" /> },
  deploying: { color: 'warning', label: 'Deploying', icon: <Spinner className="w-3 h-3" /> },
  deployed:  { color: 'success', label: 'Live', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:    { color: 'danger', label: 'Failed', icon: <XCircle className="w-3 h-3" /> },
}

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_SECRET_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'PWD', 'OLDPWD', 'NODE_ENV', 'CI', 'PORT', 'HOST',
  'GITHUB_TOKEN', 'SUI_KEYSTORE', 'SUI_ADDRESS', 'SECRETS_ENCRYPTION_KEY', 'JWT_SECRET',
  'GITHUB_CLIENT_SECRET', 'WEBHOOK_SECRET', 'WALRUS_NETWORK', 'WALRUS_EPOCHS',
])
const RESERVED_SECRET_PREFIXES = ['SUI_', 'CF_', 'CLOUDFLARE_', 'WRANGLER_', 'GLACIER_']

function validateSecretName(name: string): string | null {
  if (!SECRET_NAME_RE.test(name)) return 'Use letters, numbers, and underscores, starting with a letter or underscore.'
  const upper = name.toUpperCase()
  if (RESERVED_SECRET_NAMES.has(upper) || RESERVED_SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return `${name} is reserved.`
  }
  return null
}

function parseSecretNames(content: string): string[] {
  const names: string[] = []
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const source = line.startsWith('export ') ? line.slice(7).trimStart() : line
    const eq = source.indexOf('=')
    if (eq <= 0) throw new Error(`Invalid env line ${i + 1}`)
    const name = source.slice(0, eq).trim()
    const err = validateSecretName(name)
    if (err) throw new Error(`Line ${i + 1}: ${err}`)
    names.push(name)
  }
  return Array.from(new Set(names)).sort()
}

type Tab = 'overview' | 'deployments' | 'secrets'

export default function ProjectDetail() {
  const { encodedRepo } = useParams<{ encodedRepo: string }>()
  const { isAuthenticated } = useAuth()
  const [project, setProject] = useState<Project | null>(null)
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [secrets, setSecrets] = useState<ProjectSecret[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [deleting, setDeleting] = useState(false)
  const [hasProjectId, setHasProjectId] = useState(false)
  const [secretName, setSecretName] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [secretError, setSecretError] = useState<string | null>(null)
  const [savingSecret, setSavingSecret] = useState(false)
  const [importText, setImportText] = useState('')
  const [importFileName, setImportFileName] = useState('')
  const [importingSecrets, setImportingSecrets] = useState(false)

  const repoUrl = decodeRepoUrl(encodedRepo || '')
  const repoName = repoDisplay(repoUrl)
  const importPreview = useMemo(() => {
    try {
      return { names: parseSecretNames(importText), error: null as string | null }
    } catch (err) {
      return { names: [] as string[], error: err instanceof Error ? err.message : 'Invalid env file' }
    }
  }, [importText])

  useEffect(() => {
    if (!isAuthenticated || !repoUrl) { setLoading(false); return }
    setLoading(true)

    async function load() {
      try {
        // Try to find a real project first
        const projects = await listProjects()
        const p = projects.find((pr) => pr.repoUrl === repoUrl)

        if (p) {
          const [data, secretList] = await Promise.all([
            getProject(p.id),
            listProjectSecrets(p.id).catch(() => [] as ProjectSecret[]),
          ])
          setProject(data.project)
          setDeployments(data.deployments)
          setSecrets(secretList)
          setHasProjectId(true)
          setError(null)
          setLoading(false)
          return
        }

        // Fallback: construct a synthetic project from deployments
        const allDeployments = await listDeployments(100, 0)
        const repoDeployments = allDeployments
          .filter((d) => d.repoUrl === repoUrl)
          .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))

        if (repoDeployments.length === 0) {
          setError('Project not found')
          setLoading(false)
          return
        }

        const latest = repoDeployments[0]
        const syntheticProject: Project = {
          id: '',
          userAddress: latest.userAddress,
          repoUrl: latest.repoUrl,
          branch: latest.branch,
          baseDir: latest.baseDir,
          installCommand: latest.installCommand,
          buildCommand: latest.buildCommand,
          outputDir: latest.outputDir,
          network: latest.network,
          createdAt: latest.createdAt,
          updatedAt: latest.updatedAt,
        }

        setProject(syntheticProject)
        setDeployments(repoDeployments)
        setSecrets([])
        setHasProjectId(false)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [isAuthenticated, repoUrl])

  async function handleDelete() {
    if (!project || !hasProjectId || !confirm('Delete this project and all its deployments? This cannot be undone.')) return
    setDeleting(true)
    try {
      await deleteProject(project.id)
      window.location.href = '/dashboard'
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }

  async function handleRotateSecret() {
    if (!project || !hasProjectId) return
    const name = secretName.trim()
    const nameError = validateSecretName(name)
    if (nameError) {
      setSecretError(nameError)
      return
    }
    if (!secretValue) {
      setSecretError('Secret value is required.')
      return
    }

    setSavingSecret(true)
    setSecretError(null)
    try {
      const updated = await rotateProjectSecret(project.id, name, secretValue)
      setSecrets(updated)
      setSecretName('')
      setSecretValue('')
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : 'Failed to save secret')
    } finally {
      setSavingSecret(false)
    }
  }

  async function handleImportSecrets() {
    if (!project || !hasProjectId || !importText.trim() || importPreview.error) return
    setImportingSecrets(true)
    setSecretError(null)
    try {
      const updated = await importProjectSecrets(project.id, importText)
      setSecrets(updated)
      setImportText('')
      setImportFileName('')
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : 'Failed to import secrets')
    } finally {
      setImportingSecrets(false)
    }
  }

  async function handleDeleteSecret(name: string) {
    if (!project || !hasProjectId || !confirm(`Delete ${name}? Builds will no longer receive this variable.`)) return
    setSecretError(null)
    try {
      setSecrets(await deleteProjectSecret(project.id, name))
    } catch (err) {
      setSecretError(err instanceof Error ? err.message : 'Failed to delete secret')
    }
  }

  async function handleImportFile(file: File) {
    setImportFileName(file.name)
    setImportText(await file.text())
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="w-12 h-12 text-warning mb-4" />
        <h2 className="text-xl font-semibold mb-2">Authentication Required</h2>
        <p className="text-textMuted mb-6">Please sign in to view this project.</p>
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
        <p className="text-textMuted font-medium">Loading project...</p>
      </div>
    )
  }

  if (error || !project) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <XCircle className="w-12 h-12 text-danger mb-4" />
        <h2 className="text-xl font-semibold mb-2 text-danger">Project Not Found</h2>
        <p className="text-textMuted mb-6">{error || 'Invalid project URL.'}</p>
        <Link to="/dashboard">
          <Button variant="secondary">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
          </Button>
        </Link>
      </div>
    )
  }

  const latest = deployments[0]
  const latestStatus = latest ? STATUS[latest.status] || STATUS.queued : null
  const liveDeployment = deployments.find(
    (d) => d.status === 'deployed' && (d.base36Url || d.objectId),
  )

  let walrusRetentionOverview: React.ReactNode = null
  if (liveDeployment) {
    const effEpochs =
      liveDeployment.epochs ?? (liveDeployment.network === 'mainnet' ? 2 : 1)
    const end = approxWalStorageEndDate(
      liveDeployment.createdAt,
      liveDeployment.network,
      liveDeployment.epochs,
    )
    const endLabel = end.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })
    const days = walrusRetentionCalendarDays(liveDeployment.network, effEpochs)
    const est = liveDeployment.epochs == null
    walrusRetentionOverview = (
      <Card className="border-border">
        <CardHeader className="pb-4 border-b border-border/50">
          <CardTitle className="text-sm flex items-center gap-2 text-textMuted">
            <Clock className="w-4 h-4" /> Walrus storage (approx.)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-2">
          <p className="text-sm text-white leading-relaxed">
            The live site is stored in Walrus for roughly{' '}
            <span className="font-semibold text-info">{days} calendar days</span>
            {liveDeployment.network === 'mainnet' ? (
              <> (~{effEpochs} epochs × ~{MAINNET_DAYS_PER_EPOCH} days each)</>
            ) : (
              <> (~{effEpochs} epoch{effEpochs === 1 ? '' : 's'} × ~1 day each)</>
            )}
            {est ? ', estimated from defaults for older deploys.' : '.'}
          </p>
          <p className="text-sm text-textMuted">
            That points to about{' '}
            <span className="text-white font-medium">{endLabel}</span>
            <span className="block mt-2 text-xs opacity-80">
              Walrus follows Sui epochs; this is a calendar guide from your deploy time, not a guaranteed on-chain timestamp.
            </span>
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Top Nav */}
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="p-2 -ml-2 rounded-lg hover:bg-surface text-textMuted hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex items-center gap-2 text-sm font-medium text-textMuted">
          <LayoutDashboard className="w-4 h-4" />
          <Link to="/dashboard" className="hover:text-white transition-colors">Dashboard</Link>
          <span className="text-border">/</span>
          <span className="text-white truncate max-w-[200px]">{repoName}</span>
        </div>
      </div>

      {/* Project Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-3">
            {repoName}
          </h1>
          <a
            href={repoUrl.replace('.git', '')}
            target="_blank" rel="noopener noreferrer"
            className="text-sm text-info hover:text-info/80 transition-colors flex items-center gap-1 mt-1"
          >
            View on GitHub <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="flex items-center gap-3">
          {latestStatus && (
            <Badge variant={latestStatus.color} className="text-sm py-1 px-3 gap-2 uppercase tracking-widest font-bold">
              {latestStatus.icon} {latestStatus.label}
            </Badge>
          )}
          {hasProjectId && (
            <Button variant="danger" onClick={handleDelete} disabled={deleting} size="sm">
              {deleting ? <Spinner className="mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              {deleting ? 'Deleting...' : 'Delete Project'}
            </Button>
          )}
        </div>
      </div>

      {/* Latest Deployment Card */}
      {latest && (
        <Card className="border-border">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Latest Deployment</h2>
              <Link to={`/deployments/${latest.id}`}>
                <Button variant="secondary" size="sm">View Details</Button>
              </Link>
            </div>

            <div className="flex items-center gap-4 text-sm text-textMuted mb-4">
              <span className="flex items-center gap-1.5"><GitBranch className="w-4 h-4" /> {latest.branch}</span>
              <span className="flex items-center gap-1.5"><Globe className="w-4 h-4" /> {latest.network === 'testnet' ? 'Testnet' : 'Mainnet'}</span>
              <span className="flex items-center gap-1.5"><Calendar className="w-4 h-4" /> {new Date(latest.createdAt).toLocaleString()}</span>
            </div>

            {latest.status === 'deployed' && latest.base36Url && (
              <div className="bg-success/10 border border-success/30 rounded-xl p-4">
                <div className="text-xs font-semibold text-success uppercase tracking-wider mb-1">Live URL</div>
                <a
                  href={`https://${latest.base36Url}.wal.app`}
                  target="_blank" rel="noopener noreferrer"
                  className="group inline-flex items-center gap-2 text-lg font-bold text-success hover:text-success/80 transition-colors break-all"
                >
                  {latest.base36Url}.wal.app
                  <ExternalLink className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" />
                </a>
              </div>
            )}

            {latest.error && (
              <div className="mt-4 bg-danger/10 border border-danger/30 rounded-xl p-4">
                <div className="flex items-center gap-2 text-danger font-semibold mb-1">
                  <XCircle className="w-4 h-4" /> Build Failed
                </div>
                <pre className="text-sm text-danger/90 font-mono whitespace-pre-wrap break-words">{latest.error}</pre>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-6">
          <button
            onClick={() => setActiveTab('overview')}
            className={cn(
              "pb-3 text-sm font-medium transition-colors border-b-2",
              activeTab === 'overview' ? "text-white border-primary" : "text-textMuted border-transparent hover:text-white"
            )}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('deployments')}
            className={cn(
              "pb-3 text-sm font-medium transition-colors border-b-2",
              activeTab === 'deployments' ? "text-white border-primary" : "text-textMuted border-transparent hover:text-white"
            )}
          >
            Deployments ({deployments.length})
          </button>
          <button
            onClick={() => setActiveTab('secrets')}
            className={cn(
              "pb-3 text-sm font-medium transition-colors border-b-2",
              activeTab === 'secrets' ? "text-white border-primary" : "text-textMuted border-transparent hover:text-white"
            )}
          >
            Secrets ({secrets.length})
          </button>
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Build Config */}
            <Card>
            <CardHeader className="pb-4 border-b border-border/50">
              <CardTitle className="text-sm flex items-center gap-2 text-textMuted">
                <Code2 className="w-4 h-4" /> Build Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <DetailRow icon={<GitBranch className="w-4 h-4" />} label="Branch" value={project.branch} />
              <DetailRow icon={<Globe className="w-4 h-4" />} label="Network" value={project.network === 'testnet' ? 'Testnet' : 'Mainnet'} />
              <DetailRow icon={<Terminal className="w-4 h-4" />} label="Install Cmd" value={project.installCommand || 'auto'} />
              <DetailRow icon={<Terminal className="w-4 h-4" />} label="Build Cmd" value={project.buildCommand || 'auto'} />
              <DetailRow icon={<FolderOutput className="w-4 h-4" />} label="Output Dir" value={project.outputDir || 'auto'} />
              <DetailRow icon={<FolderOutput className="w-4 h-4" />} label="Base Dir" value={project.baseDir || '.'} />
            </CardContent>
          </Card>

          {/* Storage Details */}
          {latest?.objectId && (
            <Card>
              <CardHeader className="pb-4 border-b border-border/50">
                <CardTitle className="text-sm flex items-center gap-2 text-textMuted">
                  <Database className="w-4 h-4" /> Storage Details
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                <div className="text-xs font-mono text-info break-all bg-info/10 p-2 rounded border border-info/20">
                  ID: {latest.objectId}
                </div>
                {latest.base36Url && (
                  <a
                    href={`https://${latest.base36Url}.wal.app`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-sm text-success hover:text-success/80 transition-colors flex items-center gap-1"
                  >
                    {latest.base36Url}.wal.app <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </CardContent>
            </Card>
          )}
          </div>

          {walrusRetentionOverview}
        </div>
      ) : activeTab === 'deployments' ? (
        <div className="space-y-3">
          {deployments.length === 0 ? (
            <div className="text-center py-12 text-textMuted">No deployments for this project yet.</div>
          ) : (
            deployments.map((d) => {
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
                        <Badge variant={s.color} className="gap-1.5 uppercase tracking-wider text-[10px]">
                          {s.icon} {s.label}
                        </Badge>
                        <span className="text-xs text-textMuted font-mono">{d.id.slice(0, 8)}...</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs font-medium text-textMuted">
                        <div className="flex items-center gap-1.5">
                          <GitBranch className="w-3.5 h-3.5" /> {d.branch}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Globe className="w-3.5 h-3.5" /> {d.network === 'testnet' ? 'Testnet' : 'Mainnet'}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5" />
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
                      <ArrowLeft className="w-4 h-4 rotate-180" />
                    </div>
                  </div>
                </Link>
              )
            })
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {!hasProjectId ? (
            <Card>
              <CardContent className="py-10 text-center text-textMuted">
                Secrets are available after this repository has a project record.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card>
                  <CardHeader className="pb-4 border-b border-border/50">
                    <CardTitle className="text-sm flex items-center gap-2 text-textMuted">
                      <KeyRound className="w-4 h-4" /> Rotate Secret
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-3">
                    <Input
                      value={secretName}
                      onChange={(e) => setSecretName(e.target.value)}
                      placeholder="VITE_API_URL"
                      className="font-mono text-sm"
                    />
                    <Input
                      value={secretValue}
                      onChange={(e) => setSecretValue(e.target.value)}
                      placeholder="New value"
                      type="password"
                      className="font-mono text-sm"
                    />
                    <Button onClick={handleRotateSecret} disabled={savingSecret} className="w-full">
                      {savingSecret ? <Spinner className="mr-2" /> : <RefreshCcw className="w-4 h-4 mr-2" />}
                      Save Secret
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-4 border-b border-border/50">
                    <CardTitle className="text-sm flex items-center gap-2 text-textMuted">
                      <Upload className="w-4 h-4" /> Import Env File
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-3">
                    <label
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault()
                        const file = e.dataTransfer.files[0]
                        if (file) void handleImportFile(file)
                      }}
                      className="block rounded-lg border border-dashed border-border bg-surface/40 p-3 hover:border-info/60 transition-colors cursor-pointer"
                    >
                      <input
                        type="file"
                        accept=".env,text/plain"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) void handleImportFile(file)
                        }}
                      />
                      <div className="flex items-center gap-2 text-sm text-textMuted">
                        <Upload className="w-4 h-4" />
                        <span>{importFileName || 'Drop an .env file or click to choose one'}</span>
                      </div>
                    </label>
                    <textarea
                      value={importText}
                      onChange={(e) => {
                        setImportText(e.target.value)
                        if (!e.target.value) setImportFileName('')
                      }}
                      spellCheck={false}
                      placeholder="VITE_API_URL=https://example.com"
                      className="w-full min-h-[112px] resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-white placeholder:text-textMuted focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    {importPreview.error ? (
                      <p className="text-xs text-danger">{importPreview.error}</p>
                    ) : importPreview.names.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {importPreview.names.slice(0, 8).map((name) => (
                          <span key={name} className="rounded border border-info/30 bg-info/10 px-2 py-0.5 text-[11px] font-mono text-info">
                            {name}
                          </span>
                        ))}
                        {importPreview.names.length > 8 && <span className="text-xs text-textMuted">+{importPreview.names.length - 8} more</span>}
                      </div>
                    ) : null}
                    <Button
                      variant="secondary"
                      onClick={handleImportSecrets}
                      disabled={importingSecrets || !importText.trim() || !!importPreview.error}
                      className="w-full"
                    >
                      {importingSecrets ? <Spinner className="mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                      Import Secrets
                    </Button>
                  </CardContent>
                </Card>
              </div>

              {secretError && (
                <div className="text-sm text-danger bg-danger/10 p-3 rounded-lg border border-danger/20">
                  {secretError}
                </div>
              )}

              <Card>
                <CardHeader className="pb-4 border-b border-border/50">
                  <CardTitle className="text-sm flex items-center gap-2 text-textMuted">
                    <KeyRound className="w-4 h-4" /> Project Secrets
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {secrets.length === 0 ? (
                    <div className="py-10 text-center text-textMuted">No secrets configured.</div>
                  ) : (
                    <div className="divide-y divide-border">
                      {secrets.map((secret) => (
                        <div key={secret.name} className="flex items-center justify-between gap-4 py-4">
                          <div className="min-w-0">
                            <div className="font-mono text-sm text-white truncate">{secret.name}</div>
                            <div className="text-xs text-textMuted mt-1">
                              Last rotated {new Date(secret.updatedAt).toLocaleString()}
                            </div>
                          </div>
                          <Button variant="danger" size="sm" onClick={() => void handleDeleteSecret(secret.name)}>
                            <Trash2 className="w-4 h-4 mr-2" />
                            Delete
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
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
      <div className="text-sm font-medium text-white truncate max-w-[200px]" title={value}>
        {value}
      </div>
    </div>
  )
}
