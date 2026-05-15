import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import {
  getGithubLoginUrl,
  getGithubStatus,
  listGithubRepos, quickDetectFrameworks, detectRepoProjects,
  createDeployment, listRepoBranches, listRepoCommits, estimateCost, EstimateError,
  type GithubRepo, type FrameworkInfo, type CostEstimate, type GithubCommit,
} from '../lib/api'
import { renderAnsiLogs } from '../lib/ansi'
import {
  activeRetentionDays,
  formatApproxActiveUntilDate,
  mainnetTierIndexToEpochs,
  mainnetTierLabel,
} from '../lib/epochs'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Input } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { Search, Lock, Globe, Box, Settings2, ShieldCheck, ChevronDown, Rocket, FileCode2, Package, TerminalSquare, Terminal, Upload, KeyRound } from 'lucide-react'

// Simple SVG for GitHub since Lucide v0.300+ removed brand icons
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
      <path d="M9 18c-4.51 2-5-2-7-2"/>
    </svg>
  )
}
import { cn } from '../lib/utils'

const FRAMEWORK_BADGES: Record<string, { bg: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'outline' }> = {
  'Next.js':    { bg: 'outline' },
  'Vite':       { bg: 'info' },
  'Astro':      { bg: 'warning' },
  'Nuxt':       { bg: 'success' },
  'Gatsby':     { bg: 'default' },
  'SvelteKit':  { bg: 'warning' },
  'Remix':      { bg: 'outline' },
  'Angular':    { bg: 'danger' },
  'React':      { bg: 'info' },
  'Static HTML':{ bg: 'outline' },
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_ENV_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'PWD', 'OLDPWD', 'NODE_ENV', 'CI', 'PORT', 'HOST',
  'GITHUB_TOKEN', 'SUI_KEYSTORE', 'SUI_ADDRESS', 'SECRETS_ENCRYPTION_KEY', 'JWT_SECRET',
  'GITHUB_CLIENT_SECRET', 'WEBHOOK_SECRET', 'WALRUS_NETWORK', 'WALRUS_EPOCHS',
])
const RESERVED_ENV_PREFIXES = ['SUI_', 'CF_', 'CLOUDFLARE_', 'WRANGLER_', 'GLACIER_']

function parseEnvText(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i]
    const line = original.trim()
    if (!line || line.startsWith('#')) continue

    const source = line.startsWith('export ') ? line.slice(7).trimStart() : line
    const eq = source.indexOf('=')
    if (eq <= 0) throw new Error(`Invalid env line ${i + 1}`)

    const name = source.slice(0, eq).trim()
    let value = source.slice(eq + 1).trim()
    const upper = name.toUpperCase()
    if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid secret name on line ${i + 1}`)
    if (RESERVED_ENV_NAMES.has(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      throw new Error(`${name} is reserved`)
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
      if (original.includes('"')) {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      }
    }
    result[name] = value
  }

  return result
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

function commitTitle(message: string | null | undefined): string {
  return (message || 'No commit message').split('\n')[0]
}

export default function Deploy() {
  const { isAuthenticated, login } = useAuth()
  const navigate = useNavigate()

  // GitHub connection
  const [ghConnected, setGhConnected] = useState(false)
  const [ghUser, setGhUser] = useState<string | null>(null)

  // Repos
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [repoPage, setRepoPage] = useState(1)
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [search, setSearch] = useState('')
  const [frameworkFilter, setFrameworkFilter] = useState('')

  // Framework detection
  const [frameworks, setFrameworks] = useState<Record<string, FrameworkInfo>>({})
  const [detectingFw, setDetectingFw] = useState(false)

  // Selected repo
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null)

  // Project detection (after repo selected)
  const [projects, setProjects] = useState<Array<{ folder: string; packageManager: string; installCommand: string; buildCommand: string; outputDir: string; framework?: string }>>([])
  const [selectedFolder, setSelectedFolder] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  // Form state
  const [branch, setBranch] = useState('main')
  const [branches, setBranches] = useState<string[]>([])
  const [commits, setCommits] = useState<GithubCommit[]>([])
  const [loadingCommits, setLoadingCommits] = useState(false)
  const [commitMode, setCommitMode] = useState<'latest' | 'specific'>('latest')
  const [selectedCommitSha, setSelectedCommitSha] = useState('')
  const [manualCommitSha, setManualCommitSha] = useState('')
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('testnet')
  const [baseDir, setBaseDir] = useState('')
  const [installCmd, setInstallCmd] = useState('')
  const [buildCmd, setBuildCmd] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [siteName, setSiteName] = useState('')
  const [epochs, setEpochs] = useState<number>(1)
  /** Mainnet: 0–3 → epoch tiers 2 / 7 / 13 / 26 (default 0 = minimum retention) */
  const [mainnetTierIndex, setMainnetTierIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimate, setEstimate] = useState<CostEstimate | null>(null)
  const [estimateLogsOpen, setEstimateLogsOpen] = useState(false)
  const [estimateLogsText, setEstimateLogsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [envFileName, setEnvFileName] = useState('')

  const [showAdvanced, setShowAdvanced] = useState(false)

  const retentionDays = useMemo(
    () => activeRetentionDays(network, mainnetTierIndex, epochs),
    [network, mainnetTierIndex, epochs],
  )
  const approxActiveUntil = useMemo(
    () => formatApproxActiveUntilDate(retentionDays),
    [retentionDays],
  )
  const parsedEnv = useMemo(() => {
    try {
      return { values: parseEnvText(envText), error: null as string | null }
    } catch (err) {
      return { values: {} as Record<string, string>, error: err instanceof Error ? err.message : 'Invalid env file' }
    }
  }, [envText])
  const envNames = useMemo(() => Object.keys(parsedEnv.values).sort(), [parsedEnv.values])

  // Init — check GitHub connection (token from OAuth hash is applied in useAuth)
  useEffect(() => {
    if (!isAuthenticated) return
    void loadStatus()
  }, [isAuthenticated])

  // Clamp duration when network changes; reset estimates
  useEffect(() => {
    if (network === 'testnet') {
      setEpochs((prev) => Math.min(Math.max(prev, 1), 7))
    } else {
      setMainnetTierIndex(0)
    }
    setEstimate(null)
    setEstimateLogsOpen(false)
    setEstimateLogsText('')
  }, [network])

  useEffect(() => {
    if (!selectedRepo || !branch) return
    setCommitMode('latest')
    setSelectedCommitSha('')
    setManualCommitSha('')
    setEstimate(null)
    setEstimateLogsOpen(false)
    setEstimateLogsText('')
    void loadCommits(selectedRepo, branch)
  }, [selectedRepo, branch])

  async function loadStatus() {
    try {
      const s = await getGithubStatus()
      setGhConnected(s.connected)
      setGhUser(s.github_user)
      if (s.connected) loadRepos()
    } catch {}
  }

  async function loadRepos() {
    setLoadingRepos(true)
    try {
      const r = await listGithubRepos(1)
      setRepos(r)
      detectFrameworks(r)
    } catch {} finally { setLoadingRepos(false) }
  }

  async function loadMoreRepos() {
    const next = repoPage + 1
    setLoadingRepos(true)
    try {
      const r = await listGithubRepos(next)
      setRepos((prev) => [...prev, ...r])
      setRepoPage(next)
      detectFrameworks(r)
    } catch {} finally { setLoadingRepos(false) }
  }

  async function detectFrameworks(repoList: GithubRepo[]) {
    if (repoList.length === 0) return
    setDetectingFw(true)
    try {
      const batch = repoList.map((r) => {
        const [owner, name] = r.full_name.split('/')
        return { owner, name, branch: r.default_branch }
      })
      const results = await quickDetectFrameworks(batch)
      setFrameworks((prev) => ({ ...prev, ...results }))
    } catch {} finally { setDetectingFw(false) }
  }

  async function loadCommits(repo: GithubRepo, branchName: string) {
    setLoadingCommits(true)
    try {
      const [owner, repoName] = repo.full_name.split('/')
      setCommits(await listRepoCommits(owner, repoName, branchName))
    } catch {
      setCommits([])
    } finally {
      setLoadingCommits(false)
    }
  }

  function commitShaForRequest(): string | undefined {
    if (commitMode !== 'specific') return undefined
    return (manualCommitSha || selectedCommitSha).trim() || undefined
  }

  // Select repo → deep detect
  async function selectRepo(repo: GithubRepo) {
    setSelectedRepo(repo)
    setEstimate(null)
    setEstimateLogsOpen(false)
    setEstimateLogsText('')
    setDetecting(true)
    setDetectError(null)
    setProjects([])
    setSelectedFolder('')
    try {
      const [owner, repoName] = repo.full_name.split('/')
      const [projs, brs] = await Promise.all([
        detectRepoProjects(owner, repoName, repo.default_branch),
        listRepoBranches(owner, repoName),
      ])
      setProjects(projs)
      setBranches(brs)
      setBranch(repo.default_branch)
      if (projs.length === 1) {
        const p = projs[0]
        setSelectedFolder(p.folder)
        setBaseDir(p.folder)
        setInstallCmd(p.installCommand)
        setBuildCmd(p.buildCommand)
        setOutputDir(p.outputDir)
      } else if (projs.length > 1) {
        setDetectError('Multiple projects found. Select one from the list.')
      } else {
        setDetectError('No buildable project found. The repo needs a package.json with a build script.')
      }
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Detection failed')
    } finally { setDetecting(false) }
  }

  function selectProjFolder(folder: string) {
    const p = projects.find((x) => x.folder === folder)
    if (!p) return
    setSelectedFolder(folder)
    setBaseDir(p.folder)
    setInstallCmd(p.installCommand)
    setBuildCmd(p.buildCommand)
    setOutputDir(p.outputDir)
  }

  async function handleDeploy() {
    if (!selectedRepo) return
    const commitSha = commitShaForRequest()
    if (commitMode === 'specific' && !commitSha) {
      setError('Select a commit or paste a commit SHA.')
      return
    }
    if (parsedEnv.error) {
      setError(parsedEnv.error)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await createDeployment({
        repoUrl: selectedRepo.clone_url,
        branch: branch || undefined,
        commitSha,
        network,
        baseDir: baseDir || undefined,
        installCommand: installCmd || undefined,
        buildCommand: buildCmd || undefined,
        outputDir: outputDir || undefined,
        siteName: siteName || undefined,
        epochs: network === 'mainnet' ? mainnetTierIndexToEpochs(mainnetTierIndex) : (epochs || 1),
        env: envNames.length > 0 ? parsedEnv.values : undefined,
      })
      navigate(`/deployments/${result.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed')
      setSubmitting(false)
    }
  }

  async function handleEstimate() {
    if (!selectedRepo) return
    const commitSha = commitShaForRequest()
    if (commitMode === 'specific' && !commitSha) {
      setError('Select a commit or paste a commit SHA.')
      return
    }
    if (parsedEnv.error) {
      setError(parsedEnv.error)
      return
    }
    setEstimating(true)
    setEstimate(null)
    setError(null)
    setEstimateLogsOpen(true)
    setEstimateLogsText('')
    try {
      const result = await estimateCost({
        repoUrl: selectedRepo.clone_url,
        branch: branch || undefined,
        commitSha,
        network,
        baseDir: baseDir || undefined,
        installCommand: installCmd || undefined,
        buildCommand: buildCmd || undefined,
        outputDir: outputDir || undefined,
        epochs: network === 'mainnet' ? mainnetTierIndexToEpochs(mainnetTierIndex) : (epochs || 1),
        env: envNames.length > 0 ? parsedEnv.values : undefined,
      })
      setEstimate(result)
      setEstimateLogsText(result.logs ?? '')
    } catch (err) {
      if (err instanceof EstimateError) {
        setError(err.message)
        setEstimateLogsText(err.logs ?? '')
      } else {
        setError(err instanceof Error ? err.message : 'Estimation failed')
        setEstimateLogsText('')
      }
    } finally {
      setEstimating(false)
    }
  }

  async function connectGithub() {
    try {
      const url = await getGithubLoginUrl()
      window.location.href = url
    } catch (err) { console.error(err) }
  }

  async function handleEnvFile(file: File) {
    setEnvFileName(file.name)
    setEnvText(await file.text())
  }

  // Filter repos
  const filteredRepos = useMemo(() => {
    return repos.filter((r) => {
      const matchesSearch = r.full_name.toLowerCase().includes(search.toLowerCase())
      if (!frameworkFilter) return matchesSearch
      const fw = frameworks[r.full_name]
      return matchesSearch && fw?.framework === frameworkFilter
    })
  }, [repos, search, frameworks, frameworkFilter])

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <ShieldCheck className="w-12 h-12 text-primary mb-4" />
        <h2 className="text-2xl font-semibold mb-2">Sign in to deploy</h2>
        <p className="text-textMuted mb-6 text-center max-w-md">
          Sign in with GitHub to browse repositories and deploy to Walrus.
        </p>
        <Button onClick={() => void login()} size="lg">Sign in with GitHub</Button>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto flex flex-col lg:flex-row gap-8">

      {/* Left Column: Repo Selection & Config */}
      <div className="flex-1 min-w-0 space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight mb-2">Deploy a new project</h2>
          <p className="text-textMuted">Select a repository and configure your build settings.</p>
        </div>

        {!ghConnected ? (
          <Card className="flex flex-col items-center justify-center py-16 px-4 border-dashed bg-surface/30">
            <GithubIcon className="w-16 h-16 text-textMuted mb-6" />
            <h3 className="text-lg font-semibold mb-2">Connect GitHub</h3>
            <p className="text-textMuted text-center max-w-sm mb-6">
              Connect your GitHub account to browse your repositories and deploy seamlessly.
            </p>
            <Button onClick={connectGithub} variant="secondary" className="gap-2">
                  <GithubIcon className="w-4 h-4" />
              Connect GitHub Account
            </Button>
          </Card>
        ) : (
          <Card className="flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border bg-surface/50 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <GithubIcon className="w-4 h-4" />
                  <span>{ghUser}</span>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                  <Input
                    placeholder={loadingRepos ? 'Loading repositories...' : 'Search repositories...'}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    disabled={loadingRepos}
                    className="pl-9 bg-background"
                  />
                </div>
                <select
                  value={frameworkFilter}
                  onChange={(e) => setFrameworkFilter(e.target.value)}
                  className="h-10 px-3 bg-surface border border-border rounded-md text-sm text-textMuted focus:outline-none focus:ring-1 focus:ring-primary appearance-none flex-shrink-0"
                >
                  <option value="">All frameworks</option>
                  {Object.keys(FRAMEWORK_BADGES).map((fw) => (
                    <option key={fw} value={fw}>{fw}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto max-h-[400px] bg-background">
              {loadingRepos && repos.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-textMuted gap-2">
                  <Spinner /> Loading...
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="text-center py-12 text-textMuted">
                  {repos.length === 0 ? 'No repositories found.' : 'No matching repos.'}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {filteredRepos.slice(0, 50).map((repo) => {
                    const key = repo.full_name
                    const fw = frameworks[key] || { framework: null, color: null, pm: 'unknown' }
                    const badge = fw.framework ? FRAMEWORK_BADGES[fw.framework] : null
                    const isSelected = selectedRepo?.id === repo.id

                    return (
                      <button
                        key={repo.id}
                        onClick={() => selectRepo(repo)}
                        className={cn(
                          "w-full text-left px-4 py-3 flex items-center justify-between transition-colors hover:bg-surface",
                          isSelected && "bg-surface border-l-2 border-l-primary"
                        )}
                      >
                        <div className="flex items-center gap-3 overflow-hidden">
                          {repo.private ? <Lock className="w-4 h-4 text-textMuted flex-shrink-0" /> : <Globe className="w-4 h-4 text-textMuted flex-shrink-0" />}
                          <div className="truncate">
                            <span className={cn("font-medium", isSelected && "text-primary")}>
                              {repo.full_name}
                            </span>
                            <div className="text-xs text-textMuted truncate mt-0.5">
                              {repo.description || 'No description'}
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2 pl-4 flex-shrink-0">
                          {badge && fw.framework ? (
                            <Badge variant={badge.bg}>{fw.framework}</Badge>
                          ) : fw.pm !== 'unknown' && fw.pm !== 'none' ? (
                            <Badge variant="outline" className="text-[10px] uppercase">{fw.pm}</Badge>
                          ) : null}
                          {detectingFw && !frameworks[key] && <Spinner className="w-3 h-3 text-textMuted" />}
                        </div>
                      </button>
                    )
                  })}
                  {repos.length >= repoPage * 50 && (
                    <button
                      onClick={loadMoreRepos}
                      disabled={loadingRepos}
                      className="w-full py-4 text-sm font-medium text-info hover:bg-surface transition-colors flex items-center justify-center gap-2"
                    >
                      {loadingRepos ? <Spinner /> : 'Load more repositories'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* Right Column: Configuration & Cost */}
      {selectedRepo && (
        <div className="w-full lg:w-[420px] lg:flex-shrink-0 space-y-6">
          
          <Card className="overflow-hidden border-primary/20">
            <div className="p-4 bg-primary/10 border-b border-primary/10 flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                <Rocket className="w-4 h-4" />
              </div>
              <div>
                <h3 className="font-semibold text-primary">Configuration</h3>
                <p className="text-xs text-primary/70">{selectedRepo.full_name}</p>
              </div>
            </div>

            <div className="p-5 space-y-5">
              
              {detecting && (
                <div className="flex items-center gap-3 text-sm text-warning bg-warning/10 p-3 rounded-lg">
                  <Spinner className="text-warning" />
                  Detecting project settings...
                </div>
              )}

              {detectError && (
                <div className="text-sm text-danger bg-danger/10 p-3 rounded-lg border border-danger/20">
                  {detectError}
                </div>
              )}

              {/* Multiple Projects Selection */}
              {projects.length > 1 && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-textMuted uppercase tracking-wider">Select Project Folder</label>
                  <div className="grid gap-2">
                    {projects.map((p) => (
                      <button
                        key={p.folder}
                        onClick={() => selectProjFolder(p.folder)}
                        className={cn(
                          "text-left p-3 rounded-lg border transition-all",
                          selectedFolder === p.folder 
                            ? "bg-info/10 border-info text-white" 
                            : "bg-surface border-border hover:border-info/50"
                        )}
                      >
                        <div className="flex items-center gap-2 font-medium text-sm mb-1">
                          <Package className="w-4 h-4 text-textMuted" />
                          {p.folder === '.' ? 'Root Directory' : p.folder}
                          {p.framework && <Badge variant="info" className="ml-auto">{p.framework}</Badge>}
                        </div>
                        <div className="text-xs text-textMuted font-mono">
                          {p.packageManager} • {p.buildCommand}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Network & Branch */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-textMuted uppercase tracking-wider">Network</label>
                  <select 
                    value={network} 
                    onChange={(e) => setNetwork(e.target.value as 'mainnet' | 'testnet')}
                    className="w-full h-10 px-3 bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none"
                  >
                    <option value="testnet">🧪 Testnet</option>
                    <option value="mainnet">🌐 Mainnet</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-textMuted uppercase tracking-wider">Branch</label>
                  {branches.length > 0 ? (
                    <select 
                      value={branch} 
                      onChange={(e) => setBranch(e.target.value)}
                      className="w-full h-10 px-3 bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none"
                    >
                      {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  ) : (
                    <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs font-semibold text-textMuted uppercase tracking-wider">Commit</label>
                  {loadingCommits && <Spinner className="w-3.5 h-3.5 text-textMuted" />}
                </div>
                <select
                  value={commitMode}
                  onChange={(e) => {
                    setCommitMode(e.target.value as 'latest' | 'specific')
                    setSelectedCommitSha('')
                    setManualCommitSha('')
                    setEstimate(null)
                  }}
                  className="w-full h-10 px-3 bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none"
                >
                  <option value="latest">Latest on {branch || 'branch'}</option>
                  <option value="specific">Specific commit</option>
                </select>

                {commitMode === 'latest' ? (
                  <div className="rounded-lg border border-border bg-surface/50 px-3 py-2 text-xs text-textMuted">
                    {commits[0] ? (
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-white">
                          <span className="font-mono text-info">{shortSha(commits[0].sha)}</span>
                          <span className="truncate">{commitTitle(commits[0].message)}</span>
                        </div>
                        {commits[0].authorName && (
                          <div className="mt-1 truncate">
                            {commits[0].authorName}
                            {commits[0].authorDate ? ` • ${new Date(commits[0].authorDate).toLocaleString()}` : ''}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span>{loadingCommits ? 'Loading latest commit...' : 'Latest commit will be resolved when deployment starts.'}</span>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <select
                      value={selectedCommitSha}
                      onChange={(e) => {
                        setSelectedCommitSha(e.target.value)
                        if (e.target.value) setManualCommitSha('')
                        setEstimate(null)
                      }}
                      className="w-full h-10 px-3 bg-surface border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none"
                    >
                      <option value="">Recent commits on {branch || 'branch'}</option>
                      {commits.map((commit) => (
                        <option key={commit.sha} value={commit.sha}>
                          {shortSha(commit.sha)} — {commitTitle(commit.message)}
                        </option>
                      ))}
                    </select>
                    <Input
                      value={manualCommitSha}
                      onChange={(e) => {
                        setManualCommitSha(e.target.value)
                        if (e.target.value) setSelectedCommitSha('')
                        setEstimate(null)
                      }}
                      placeholder="Or paste a commit SHA"
                      className="font-mono text-sm"
                    />
                  </div>
                )}
              </div>

              {/* Storage duration (human time; API uses epochs) */}
              <div className="space-y-3">
                <div className="flex justify-between items-center gap-2">
                  <label className="text-xs font-semibold text-textMuted uppercase tracking-wider">Storage duration</label>
                  <span className="text-sm font-bold text-info text-right">
                    {network === 'mainnet'
                      ? mainnetTierLabel(mainnetTierIndex)
                      : `${epochs} ${epochs === 1 ? 'day' : 'days'}`}
                  </span>
                </div>
                {network === 'mainnet' ? (
                  <input
                    type="range"
                    min={0}
                    max={3}
                    step={1}
                    value={mainnetTierIndex}
                    onChange={(e) => setMainnetTierIndex(Number(e.target.value))}
                    className="w-full accent-info"
                  />
                ) : (
                  <input
                    type="range"
                    min={1}
                    max={7}
                    step={1}
                    value={epochs}
                    onChange={(e) => setEpochs(Number(e.target.value))}
                    className="w-full accent-info"
                  />
                )}
                <p className="text-xs text-textMuted leading-snug">
                  Approximately active until{' '}
                  <span className="text-textMuted/90">{approxActiveUntil}</span>
                  {' '}(from today; chain timing may differ slightly).
                </p>
              </div>

              {/* Advanced Settings Toggle */}
              <button 
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-sm font-medium text-textMuted hover:text-white transition-colors py-2"
              >
                <Settings2 className="w-4 h-4" />
                Build Settings
                <ChevronDown className={cn("w-4 h-4 transition-transform ml-auto", showAdvanced && "rotate-180")} />
              </button>

              {/* Advanced Settings Form */}
              {showAdvanced && (
                <div className="space-y-4 pt-2 border-t border-border/50">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-textMuted">Site Name (Optional)</label>
                    <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="my-awesome-site" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-textMuted">Base Directory</label>
                    <Input value={baseDir} onChange={(e) => setBaseDir(e.target.value)} placeholder="." className="font-mono text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-textMuted">Install Command</label>
                    <Input value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} placeholder="npm install" className="font-mono text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-textMuted">Build Command</label>
                    <Input value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} placeholder="npm run build" className="font-mono text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-textMuted">Output Directory</label>
                    <Input value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="dist" className="font-mono text-sm" />
                  </div>
                </div>
              )}

              <div className="space-y-3 pt-2 border-t border-border/50">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-textMuted" />
                    <label className="text-xs font-semibold text-textMuted uppercase tracking-wider">Build Env</label>
                  </div>
                  {envNames.length > 0 && (
                    <span className="text-xs text-info">{envNames.length} secret{envNames.length === 1 ? '' : 's'}</span>
                  )}
                </div>
                <label
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    const file = e.dataTransfer.files[0]
                    if (file) void handleEnvFile(file)
                  }}
                  className="block rounded-lg border border-dashed border-border bg-surface/40 p-3 hover:border-info/60 transition-colors cursor-pointer"
                >
                  <input
                    type="file"
                    accept=".env,text/plain"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void handleEnvFile(file)
                    }}
                  />
                  <div className="flex items-center gap-2 text-sm text-textMuted">
                    <Upload className="w-4 h-4" />
                    <span>{envFileName || 'Drop an .env file or click to choose one'}</span>
                  </div>
                </label>
                <textarea
                  value={envText}
                  onChange={(e) => {
                    setEnvText(e.target.value)
                    if (!e.target.value) setEnvFileName('')
                  }}
                  spellCheck={false}
                  placeholder="VITE_API_URL=https://example.com"
                  className="w-full min-h-[96px] resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-white placeholder:text-textMuted focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {parsedEnv.error ? (
                  <p className="text-xs text-danger">{parsedEnv.error}</p>
                ) : envNames.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {envNames.slice(0, 8).map((name) => (
                      <span key={name} className="rounded border border-info/30 bg-info/10 px-2 py-0.5 text-[11px] font-mono text-info">
                        {name}
                      </span>
                    ))}
                    {envNames.length > 8 && <span className="text-xs text-textMuted">+{envNames.length - 8} more</span>}
                  </div>
                ) : (
                  <p className="text-xs text-textMuted">Values are saved as project secrets and injected into install/build only.</p>
                )}
              </div>

              {error && (
                <div className="text-sm text-danger bg-danger/10 p-3 rounded-lg border border-danger/20 flex items-start gap-2">
                  <TerminalSquare className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* Cost Estimator */}
              <div className="pt-4 border-t border-border">
                {!estimate ? (
                  <Button
                    variant="secondary"
                    className="w-full border-dashed bg-surface/50"
                    onClick={handleEstimate}
                    disabled={estimating || !selectedRepo || detecting || !!parsedEnv.error}
                  >
                    {estimating ? <Spinner className="mr-2" /> : <FileCode2 className="w-4 h-4 mr-2" />}
                    {estimating ? 'Calculating Cost...' : 'Calculate Storage Cost'}
                  </Button>
                ) : (
                  <div className="bg-[#0d1a2b] rounded-lg border border-info/30 p-4 text-sm">
                    <div className="flex justify-between mb-2">
                      <span className="text-textMuted">Output Size</span>
                      <span className="font-semibold text-white">
                        {estimate.totalBytes < 1024 * 1024
                          ? `${(estimate.totalBytes / 1024).toFixed(1)} KB`
                          : `${(estimate.totalBytes / (1024 * 1024)).toFixed(2)} MB`}
                      </span>
                    </div>
                    <div className="flex justify-between mb-2">
                      <span className="text-textMuted">Est. WAL</span>
                      <span className="font-semibold text-warning">
                        {estimate.estimatedWal < 0.01 ? '<0.01' : estimate.estimatedWal.toFixed(2)} WAL
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-textMuted">Est. SUI Gas</span>
                      <span className="font-semibold text-info">~{estimate.estimatedSuiGas} SUI</span>
                    </div>
                    <div className="mt-3 pt-3 border-t border-info/20 text-xs text-textMuted font-mono text-center">
                      <button
                        type="button"
                        onClick={() => {
                          setEstimate(null)
                          setEstimateLogsOpen(false)
                          setEstimateLogsText('')
                        }}
                        className="hover:text-white underline decoration-textMuted/50"
                      >
                        Recalculate
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {estimateLogsOpen && (
                <div className="rounded-lg border border-border overflow-hidden bg-black flex flex-col min-h-[220px] max-h-[min(480px,50vh)]">
                  <div className="bg-surface border-b border-border px-3 py-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-textMuted">
                      <Terminal className="w-3.5 h-3.5" />
                      Cost estimate — build output
                    </div>
                    {estimating && (
                      <span className="text-[10px] font-medium text-warning bg-warning/10 px-2 py-0.5 rounded-full flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                        Running
                      </span>
                    )}
                  </div>
                  <div className="flex-1 p-3 overflow-x-auto overflow-y-auto font-mono text-xs leading-relaxed min-h-0">
                    {estimating && !estimateLogsText ? (
                      <p className="text-textMuted">Cloning repository and running install / build on the worker…</p>
                    ) : estimateLogsText ? (
                      <pre
                        className="text-textMuted whitespace-pre-wrap break-words"
                        dangerouslySetInnerHTML={{ __html: renderAnsiLogs(estimateLogsText) }}
                      />
                    ) : (
                      <p className="text-textMuted">(no log output)</p>
                    )}
                  </div>
                </div>
              )}

              <Button
                size="lg"
                className="w-full font-bold text-base shadow-lg shadow-primary/20"
                onClick={handleDeploy}
                disabled={submitting || detecting || !!parsedEnv.error || (projects.length > 1 && !selectedFolder)}
              >
                {submitting ? <Spinner className="mr-2" /> : <Rocket className="w-5 h-5 mr-2" />}
                {submitting ? 'Deploying...' : 'Deploy to Walrus'}
              </Button>

            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
