const API_BASE = import.meta.env.VITE_API_BASE || '/api'

export function getToken(): string | null {
  return localStorage.getItem('glacier_token')
}

export function setToken(token: string): void {
  localStorage.setItem('glacier_token', token)
}

export function clearToken(): void {
  localStorage.removeItem('glacier_token')
}

async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${API_BASE}${path}`, { ...options, headers })
}

export async function getNonce(address: string): Promise<{ nonce: string; message: string }> {
  const resp = await fetch(`${API_BASE}/auth/nonce?address=${address}`)
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'failed to get nonce') }
  return resp.json()
}

export async function verifySignature(address: string, message: string, signature: string): Promise<{ token: string; address: string }> {
  const resp = await fetch(`${API_BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, message, signature }),
  })
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'verification failed') }
  return resp.json()
}

// ── Deployments ──

export interface Deployment {
  id: string; userAddress: string; repoUrl: string; branch: string; baseDir: string
  installCommand: string | null; buildCommand: string | null; outputDir: string | null
  network: 'mainnet' | 'testnet'; status: string; error: string | null
  objectId: string | null; base36Url: string | null; logs: string
  createdAt: string; updatedAt: string
}

export interface DeployRequest {
  repoUrl: string; branch?: string; network?: 'mainnet' | 'testnet'
  baseDir?: string; installCommand?: string; buildCommand?: string; outputDir?: string; siteName?: string
  epochs?: number | 'max'
}

export async function createDeployment(req: DeployRequest): Promise<{ id: string; status: string }> {
  const resp = await authFetch('/deploy', { method: 'POST', body: JSON.stringify(req) })
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'deploy failed') }
  return resp.json()
}

export async function getDeployment(id: string): Promise<Deployment> {
  const resp = await authFetch(`/deployments/${id}`)
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'not found') }
  return resp.json()
}

export async function listDeployments(limit = 20, offset = 0): Promise<Deployment[]> {
  const resp = await authFetch(`/deployments?limit=${limit}&offset=${offset}`)
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'failed to list') }
  const data = await resp.json()
  return data.deployments || []
}

export async function deleteDeployment(id: string): Promise<void> {
  const resp = await authFetch(`/deployments/${id}`, { method: 'DELETE' })
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'delete failed') }
}

export async function retryDeployment(id: string): Promise<{ id: string; status: string }> {
  const resp = await authFetch(`/deployments/${id}/retry`, { method: 'POST' })
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'retry failed') }
  return resp.json()
}

// ── Cost Estimation ──

export interface CostEstimate {
  buildId?: string
  distPath?: string
  fileCount: number
  totalBytes: number
  sizeGib: number
  epochs: number | 'max'
  network: 'mainnet' | 'testnet'
  estimatedWal: number
  estimatedSuiGas: number
  formula: string
  error?: string
}

export async function estimateCost(req: DeployRequest): Promise<CostEstimate> {
  const resp = await authFetch('/estimate', { method: 'POST', body: JSON.stringify(req) })
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error || 'estimation failed') }
  return resp.json()
}

// ── GitHub ──

export interface GithubRepo {
  id: number; name: string; full_name: string; private: boolean
  html_url: string; clone_url: string; default_branch: string
  description: string | null; updated_at: string; language: string | null
}

export interface DetectedProject {
  folder: string; packageManager: string; installCommand: string; buildCommand: string; outputDir: string; framework?: string
}

export interface FrameworkInfo {
  framework: string | null; color: string | null; pm: string
}

export async function getGithubOAuthUrl(): Promise<string> {
  const resp = await authFetch('/github/auth')
  if (!resp.ok) throw new Error('failed to get OAuth URL')
  const data = await resp.json(); return data.url
}

export async function linkGithub(accessToken: string, githubUser: string): Promise<void> {
  const resp = await authFetch(`/github/link?token=${encodeURIComponent(accessToken)}&gh_user=${encodeURIComponent(githubUser)}`)
  if (!resp.ok) throw new Error('failed to link GitHub')
}

export async function getGithubStatus(): Promise<{ connected: boolean; github_user: string | null }> {
  const resp = await authFetch('/github/status')
  if (!resp.ok) return { connected: false, github_user: null }
  return resp.json()
}

export async function listGithubRepos(page = 1): Promise<GithubRepo[]> {
  const resp = await authFetch(`/github/repos?page=${page}`)
  if (!resp.ok) throw new Error('failed to list repos')
  const data = await resp.json(); return data.repos || []
}

export async function detectRepoProjects(owner: string, repo: string, branch?: string): Promise<DetectedProject[]> {
  const resp = await authFetch(`/github/repos/${owner}/${repo}/detect`, { method: 'POST', body: JSON.stringify({ branch }) })
  if (!resp.ok) throw new Error('detection failed')
  const data = await resp.json(); return data.projects || []
}

export async function listRepoBranches(owner: string, repo: string): Promise<string[]> {
  const resp = await authFetch(`/github/repos/${owner}/${repo}/branches`)
  if (!resp.ok) return ['main']
  const data = await resp.json(); return data.branches || ['main']
}

export async function quickDetectFrameworks(repos: Array<{ owner: string; name: string; branch: string }>): Promise<Record<string, FrameworkInfo>> {
  const resp = await authFetch('/github/repos/detect-frameworks', { method: 'POST', body: JSON.stringify({ repos }) })
  if (!resp.ok) return {}
  const data = await resp.json(); return data.results || {}
}
