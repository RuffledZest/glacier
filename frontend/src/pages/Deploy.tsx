import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { useAuth } from '../hooks/useAuth'
import {
  getGithubOAuthUrl, linkGithub, getGithubStatus,
  listGithubRepos, quickDetectFrameworks, detectRepoProjects,
  createDeployment, listRepoBranches, estimateCost,
  type GithubRepo, type FrameworkInfo, type CostEstimate,
} from '../lib/api'

const FRAMEWORK_BADGES: Record<string, { icon: string; bg: string }> = {
  'Next.js':    { icon: '▲', bg: '#000000' },
  'Vite':       { icon: '⚡', bg: '#646CFF' },
  'Astro':      { icon: '🚀', bg: '#FF5A03' },
  'Nuxt':       { icon: '💚', bg: '#00DC82' },
  'Gatsby':     { icon: '💜', bg: '#663399' },
  'SvelteKit':  { icon: '🧡', bg: '#FF3E00' },
  'Remix':      { icon: '💿', bg: '#121212' },
  'Angular':    { icon: '🅰️', bg: '#DD0031' },
  'React':      { icon: '⚛️', bg: '#61DAFB' },
  'Static HTML':{ icon: '🌐', bg: '#E34F26' },
}

export default function Deploy() {
  const { isAuthenticated, login } = useAuth()
  const account = useCurrentAccount()
  const navigate = useNavigate()

  // GitHub connection
  const [ghConnected, setGhConnected] = useState(false)
  const [ghUser, setGhUser] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  // Repos
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [repoPage, setRepoPage] = useState(1)
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [search, setSearch] = useState('')

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
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('testnet')
  const [baseDir, setBaseDir] = useState('')
  const [installCmd, setInstallCmd] = useState('')
  const [buildCmd, setBuildCmd] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [siteName, setSiteName] = useState('')
  const [epochs, setEpochs] = useState<number>(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimate, setEstimate] = useState<CostEstimate | null>(null)

  // Init — check GitHub connection
  useEffect(() => {
    if (!isAuthenticated) return
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    const ghUserParam = params.get('gh_user')
    if (token) {
      setLinking(true)
      linkGithub(token, ghUserParam || '').then(() => {
        window.history.replaceState({}, '', '/deploy')
        loadStatus()
      }).catch(console.error).finally(() => setLinking(false))
    } else {
      loadStatus()
    }
  }, [isAuthenticated])

  // Clamp epochs when network changes
  useEffect(() => {
    if (network === 'testnet') {
      setEpochs((prev) => Math.min(Math.max(prev, 1), 7))
    }
    setEstimate(null)
  }, [network])

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

  // Select repo → deep detect
  async function selectRepo(repo: GithubRepo) {
    setSelectedRepo(repo)
    setEstimate(null)
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
    setSubmitting(true)
    setError(null)
    try {
      const result = await createDeployment({
        repoUrl: selectedRepo.clone_url,
        branch: branch || undefined,
        network,
        baseDir: baseDir || undefined,
        installCommand: installCmd || undefined,
        buildCommand: buildCmd || undefined,
        outputDir: outputDir || undefined,
        siteName: siteName || undefined,
        epochs: network === 'mainnet' ? 'max' : (epochs || 1),
      })
      navigate(`/deployments/${result.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed')
      setSubmitting(false)
    }
  }

  async function handleEstimate() {
    if (!selectedRepo) return
    setEstimating(true)
    setEstimate(null)
    setError(null)
    try {
      const result = await estimateCost({
        repoUrl: selectedRepo.clone_url,
        branch: branch || undefined,
        network,
        baseDir: baseDir || undefined,
        installCommand: installCmd || undefined,
        buildCommand: buildCmd || undefined,
        outputDir: outputDir || undefined,
        epochs: network === 'mainnet' ? 'max' : (epochs || 1),
      })
      if (result.error) {
        setError(result.error)
      } else {
        setEstimate(result)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Estimation failed')
    } finally {
      setEstimating(false)
    }
  }

  async function connectGithub() {
    try {
      const url = await getGithubOAuthUrl()
      window.location.href = url
    } catch (err) { console.error(err) }
  }

  // Filter repos
  const filteredRepos = useMemo(() => {
    return repos.filter((r) => r.full_name.toLowerCase().includes(search.toLowerCase()))
  }, [repos, search])

  if (!account) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px' }}>
        <p style={{ color: '#8b949e', marginBottom: 16 }}>Connect your wallet to deploy.</p>
        <ConnectButton connectText="Connect Phantom Wallet" />
      </div>
    )
  }
  if (!isAuthenticated) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px' }}>
        <p style={{ color: '#8b949e', marginBottom: 16 }}>Sign in to continue.</p>
        <button onClick={login} style={{ background: '#238636', color: '#fff', padding: '12px 32px', fontSize: 15, borderRadius: 8 }}>
          Sign In
        </button>
      </div>
    )
  }
  if (linking) return <p style={{ color: '#8b949e', textAlign: 'center', padding: 60 }}>Linking GitHub account...</p>

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f0f6fc', marginBottom: 6 }}>New Deployment</h2>
      <p style={{ fontSize: 13, color: '#8b949e', marginBottom: 28 }}>
        Select a repository to deploy to Walrus.
      </p>

      {!ghConnected ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🐙</div>
          <p style={{ color: '#8b949e', marginBottom: 20 }}>Connect your GitHub account to browse repositories.</p>
          <button onClick={connectGithub} style={{ background: '#2da44e', color: '#fff', padding: '12px 28px', fontSize: 15, fontWeight: 600, borderRadius: 8 }}>
            Connect GitHub Account
          </button>
        </div>
      ) : (
        <>
          {/* Repo selector */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, color: '#8b949e', marginBottom: 8, fontWeight: 500 }}>
              Select Repository
            </label>
            <input
              type="text"
              placeholder={loadingRepos ? 'Loading repositories...' : 'Search repositories...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={loadingRepos}
              style={{ marginBottom: 10 }}
            />
            <div style={{
              maxHeight: 300, overflow: 'auto',
              background: '#0d1117', borderRadius: 8, border: '1px solid #21262d',
            }}>
              {loadingRepos && repos.length === 0 ? (
                <div style={{ padding: 20, color: '#8b949e', fontSize: 13, textAlign: 'center' }}>Loading...</div>
              ) : filteredRepos.length === 0 ? (
                <div style={{ padding: 20, color: '#8b949e', fontSize: 13, textAlign: 'center' }}>
                  {repos.length === 0 ? 'No repositories found.' : 'No matching repos.'}
                </div>
              ) : (
                filteredRepos.slice(0, 50).map((repo) => {
                  const key = repo.full_name
                  const fw: FrameworkInfo = frameworks[key] || { framework: null, color: null, pm: 'unknown' }
                  const badge = fw.framework ? FRAMEWORK_BADGES[fw.framework] : null
                  const isSelected = selectedRepo?.id === repo.id
                  return (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => selectRepo(repo)}
                      style={{
                        width: '100%', textAlign: 'left',
                        padding: '12px 14px', background: isSelected ? '#161b22' : 'transparent',
                        border: 'none', borderBottom: '1px solid #21262d',
                        color: '#c9d1d9', cursor: 'pointer', display: 'flex',
                        justifyContent: 'space-between', alignItems: 'center',
                        transition: 'background 0.1s',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>{repo.full_name}</div>
                        <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>
                          {repo.private ? '🔒 Private' : '🌐 Public'}
                          {repo.description && ` · ${repo.description.slice(0, 60)}${repo.description.length > 60 ? '...' : ''}`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {badge ? (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                            background: `${badge.bg}20`, color: badge.bg === '#000000' ? '#8b949e' : badge.bg,
                            border: `1px solid ${badge.bg}40`,
                          }}>
                            {badge.icon} {fw.framework}
                          </span>
                        ) : fw.pm !== 'unknown' && fw.pm !== 'none' ? (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 500,
                            background: '#21262d', color: '#8b949e', border: '1px solid #30363d',
                          }}>
                            {fw.pm}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#484f58' }}>—</span>
                        )}
                        {detectingFw && !frameworks[key] && (
                          <span style={{ fontSize: 11, color: '#484f58' }}>...</span>
                        )}
                      </div>
                    </button>
                  )
                })
              )}
              {repos.length >= repoPage * 50 && (
                <button
                  type="button"
                  onClick={loadMoreRepos}
                  disabled={loadingRepos}
                  style={{
                    width: '100%', padding: '12px', background: 'transparent', border: 'none',
                    color: '#58a6ff', fontSize: 13, cursor: 'pointer',
                  }}
                >
                  {loadingRepos ? 'Loading...' : 'Load more repositories'}
                </button>
              )}
            </div>
            {ghUser && (
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Connected as {ghUser}
              </div>
            )}
          </div>

          {/* Selected repo details */}
          {selectedRepo && (
            <>
              <div style={{
                padding: 14, background: detecting ? '#161b22' : '#0d2b1a',
                borderRadius: 8, border: detecting ? '1px solid #21262d' : '1px solid #238636',
                marginBottom: 20, fontSize: 13, color: detecting ? '#8b949e' : '#3fb950',
              }}>
                {detecting ? 'Detecting project configuration...' : (
                  `Selected: ${selectedRepo.full_name}`
                )}
              </div>

              {detectError && (
                <div style={{
                  padding: 14, background: '#490202', border: '1px solid #f85149',
                  borderRadius: 8, color: '#f85149', fontSize: 13, marginBottom: 20,
                }}>
                  {detectError}
                </div>
              )}

              {/* Multiple project folders */}
              {projects.length > 1 && (
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: 'block', fontSize: 13, color: '#8b949e', marginBottom: 8, fontWeight: 500 }}>
                    Select Project Folder
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {projects.map((p) => (
                      <button
                        key={p.folder}
                        type="button"
                        onClick={() => selectProjFolder(p.folder)}
                        style={{
                          textAlign: 'left', padding: '12px 14px',
                          background: selectedFolder === p.folder ? '#1f2937' : '#161b22',
                          border: selectedFolder === p.folder ? '1px solid #58a6ff' : '1px solid #21262d',
                          borderRadius: 8, color: '#c9d1d9',
                        }}
                      >
                        <div style={{ fontSize: 14, fontWeight: 500 }}>
                          {p.folder === '.' ? 'Root' : p.folder}
                          {p.framework && <span style={{ color: '#58a6ff', fontSize: 12, marginLeft: 8 }}>({p.framework})</span>}
                        </div>
                        <div style={{ fontSize: 11, color: '#8b949e', marginTop: 3 }}>
                          {p.packageManager} · build: {p.buildCommand} · output: {p.outputDir}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Branch + Network */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#8b949e', marginBottom: 5, fontWeight: 500 }}>Branch</label>
                  {branches.length > 0 ? (
                    <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                      {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} />
                  )}
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#8b949e', marginBottom: 5, fontWeight: 500 }}>Network</label>
                  <select value={network} onChange={(e) => setNetwork(e.target.value as 'mainnet' | 'testnet')}>
                    <option value="testnet">🧪 Testnet</option>
                    <option value="mainnet">🌐 Mainnet</option>
                  </select>
                </div>
              </div>

              {/* Epochs */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                  <label style={{ fontSize: 12, color: '#8b949e', fontWeight: 500 }}>Epochs</label>
                  <span style={{ fontSize: 12, color: '#58a6ff', fontWeight: 600 }}>
                    {network === 'mainnet' ? 'max' : epochs}
                  </span>
                </div>
                {network === 'mainnet' ? (
                  <input type="text" value="max (no limit)" disabled
                    style={{ opacity: 0.6 }} />
                ) : (
                  <input
                    type="range"
                    min={1} max={7} step={1}
                    value={epochs}
                    onChange={(e) => setEpochs(Number(e.target.value))}
                    style={{ width: '100%', padding: 0, height: 24, accentColor: '#58a6ff' }}
                  />
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#484f58', marginTop: 2 }}>
                  {network === 'testnet' && (
                    <>
                      <span>1</span>
                      <span>2</span>
                      <span>3</span>
                      <span>4</span>
                      <span>5</span>
                      <span>6</span>
                      <span>7</span>
                    </>
                  )}
                </div>
              </div>

              {/* Cost estimation */}
              <div style={{ marginBottom: 20 }}>
                {!estimate ? (
                  <button
                    type="button"
                    onClick={handleEstimate}
                    disabled={estimating || !selectedRepo}
                    style={{
                      width: '100%', padding: '10px', fontSize: 13, fontWeight: 500,
                      background: estimating ? '#21262d' : '#1f2937',
                      color: estimating ? '#484f58' : '#58a6ff',
                      border: '1px solid #30363d', borderRadius: 6,
                      cursor: estimating || !selectedRepo ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {estimating ? 'Building to calculate cost...' : '🧮 Calculate Cost'}
                  </button>
                ) : (
                  <div style={{
                    padding: 14, background: '#0d1a2b', borderRadius: 8,
                    border: '1px solid #1f6feb30', fontSize: 13, color: '#c9d1d9',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ color: '#8b949e' }}>Output size</span>
                      <span style={{ fontWeight: 600 }}>
                        {estimate.totalBytes < 1024 * 1024
                          ? `${(estimate.totalBytes / 1024).toFixed(1)} KB`
                          : `${(estimate.totalBytes / (1024 * 1024)).toFixed(2)} MB`}
                        {' · '}{estimate.fileCount} files
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ color: '#8b949e' }}>Epochs</span>
                      <span style={{ fontWeight: 600 }}>{estimate.epochs}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ color: '#8b949e' }}>Est. WAL</span>
                      <span style={{ fontWeight: 600, color: '#d29922' }}>
                        {estimate.estimatedWal < 0.01 ? '<0.01' : estimate.estimatedWal.toFixed(2)} WAL
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#8b949e' }}>Est. SUI gas</span>
                      <span style={{ fontWeight: 600, color: '#58a6ff' }}>
                        ~{estimate.estimatedSuiGas} SUI
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: '#484f58', marginTop: 6, borderTop: '1px solid #21262d', paddingTop: 6 }}>
                      {estimate.formula}
                    </div>
                    <button
                      type="button"
                      onClick={() => setEstimate(null)}
                      style={{
                        marginTop: 8, background: 'transparent', color: '#8b949e',
                        border: 'none', cursor: 'pointer', fontSize: 11, textDecoration: 'underline',
                      }}
                    >
                      Recalculate
                    </button>
                  </div>
                )}
              </div>

              {/* Build config */}
              <details style={{ color: '#8b949e', marginBottom: 20 }}>
                <summary style={{ fontSize: 12, cursor: 'pointer', color: '#58a6ff', fontWeight: 500 }}>
                  Build configuration
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Base Directory</label>
                    <input type="text" value={baseDir} onChange={(e) => setBaseDir(e.target.value)} placeholder="." />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Install Command</label>
                    <input type="text" value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Build Command</label>
                    <input type="text" value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Output Directory</label>
                    <input type="text" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="dist" />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: '#8b949e', marginBottom: 3 }}>Site Name (optional)</label>
                    <input type="text" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="My Site" />
                  </div>
                </div>
              </details>

              {error && (
                <div style={{
                  padding: 12, background: '#490202', border: '1px solid #f85149',
                  borderRadius: 6, color: '#f85149', fontSize: 13, marginBottom: 16,
                }}>
                  {error}
                </div>
              )}

              <button
                onClick={handleDeploy}
                disabled={submitting || detecting || projects.length > 1 && !selectedFolder}
                style={{
                  width: '100%', padding: '14px', fontSize: 16, fontWeight: 700,
                  background: submitting || detecting ? '#21262d' : '#238636',
                  color: submitting || detecting ? '#8b949e' : '#fff',
                  borderRadius: 8, border: 'none', cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >
                {submitting ? 'Deploying...' : detecting ? 'Detecting...' : 'Deploy to Walrus'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
