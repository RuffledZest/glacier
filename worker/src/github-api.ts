// GitHub API client — runs in Worker, calls GitHub's REST API

export interface GithubRepo {
  id: number
  name: string
  full_name: string
  private: boolean
  html_url: string
  clone_url: string
  default_branch: string
  description: string | null
  updated_at: string
  language: string | null
}

export interface GithubContent {
  name: string
  path: string
  type: 'file' | 'dir' | 'blob' | 'tree'
  size: number
  sha: string
  url: string
}

export interface DetectedProject {
  folder: string
  packageManager: string
  installCommand: string
  buildCommand: string
  outputDir: string
  framework?: string
}

export interface GithubCommit {
  sha: string
  message: string
  authorName: string | null
  authorDate: string | null
  htmlUrl: string | null
}

export function getOAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo',
    state,
  })
  return `https://github.com/login/oauth/authorize?${params}`
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string
): Promise<{ access_token: string; github_user: string; github_id: number }> {
  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'glacier',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`GitHub OAuth failed: ${resp.status} ${text}`)
  }

  const data = (await resp.json()) as {
    access_token: string
    error?: string
    error_description?: string
  }

  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`)
  }

  const userResp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${data.access_token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'glacier',
    },
  })
  if (!userResp.ok) {
    const text = await userResp.text()
    throw new Error(`GitHub user fetch failed: ${userResp.status} ${text}`)
  }
  const userData = (await userResp.json()) as { login: string; id: number }
  if (typeof userData.id !== 'number' || !userData.login) {
    throw new Error('GitHub user response missing id or login')
  }

  return {
    access_token: data.access_token,
    github_user: userData.login,
    github_id: userData.id,
  }
}

async function ghFetch(token: string, path: string): Promise<Response> {
  const url = path.startsWith('https://')
    ? path
    : `https://api.github.com${path}`
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'glacier',
    },
  })
}

export async function listRepos(token: string, page = 1, perPage = 50): Promise<GithubRepo[]> {
  const resp = await ghFetch(
    token,
    `/user/repos?sort=updated&per_page=${perPage}&page=${page}&type=all`
  )
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`)
  return (await resp.json()) as GithubRepo[]
}

function mapCommit(data: {
  sha?: string
  html_url?: string
  commit?: {
    message?: string
    author?: { name?: string; date?: string } | null
  }
}): GithubCommit | null {
  if (!data.sha) return null
  return {
    sha: data.sha,
    message: data.commit?.message || '',
    authorName: data.commit?.author?.name || null,
    authorDate: data.commit?.author?.date || null,
    htmlUrl: data.html_url || null,
  }
}

export async function getCommit(token: string, owner: string, repo: string, ref: string): Promise<GithubCommit | null> {
  const resp = await ghFetch(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`)
  if (!resp.ok) return null
  return mapCommit(await resp.json())
}

export async function listCommits(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  perPage = 20,
): Promise<GithubCommit[]> {
  const params = new URLSearchParams({ sha: branch, per_page: String(perPage) })
  const resp = await ghFetch(token, `/repos/${owner}/${repo}/commits?${params}`)
  if (!resp.ok) return []
  const data = (await resp.json()) as unknown[]
  return data
    .map((item) => mapCommit(item as Parameters<typeof mapCommit>[0]))
    .filter((item): item is GithubCommit => !!item)
}

export async function isCommitReachableFromRef(
  token: string,
  owner: string,
  repo: string,
  commitSha: string,
  branch: string,
): Promise<boolean> {
  const resp = await ghFetch(
    token,
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(commitSha)}...${encodeURIComponent(branch)}`
  )
  if (!resp.ok) return false
  const data = (await resp.json()) as { status?: string }
  return data.status === 'identical' || data.status === 'ahead'
}

export async function listContents(
  token: string,
  owner: string,
  repo: string,
  path = ''
): Promise<GithubContent[]> {
  const apiPath = path
    ? `/repos/${owner}/${repo}/contents/${path}`
    : `/repos/${owner}/${repo}/contents`
  const resp = await ghFetch(token, apiPath)
  if (!resp.ok) return []
  const data = await resp.json()
  return Array.isArray(data) ? data : []
}

export async function getRepoTree(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<GithubContent[]> {
  const resp = await ghFetch(
    token,
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  )
  if (!resp.ok) return []
  const data = (await resp.json()) as { tree?: GithubContent[] }
  return data.tree || []
}

// Deep traversal: find all directories containing package.json with a build script
export async function detectProjects(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<DetectedProject[]> {
  const tree = await getRepoTree(token, owner, repo, branch)
  if (!tree.length) return []

  // Find all package.json files (Trees API returns 'blob' for files)
  const pkgFiles = tree.filter(
    (f) => f.type === 'blob' && f.path.endsWith('package.json')
  )

  const projects: DetectedProject[] = []

  for (const pkg of pkgFiles) {
    // Get folder containing this package.json
    const folder = pkg.path === 'package.json' ? '.' : pkg.path.replace('/package.json', '')

    // Check if this folder has a build script (by reading the file via contents API)
    const pkgContent = await listContents(token, owner, repo, pkg.path)
    // listContents returns array for files too? No — for files it returns a single object.
    // Let me use the raw API instead.

    // Actually, let me use the contents API differently
    const resp = await ghFetch(token, `/repos/${owner}/${repo}/contents/${pkg.path}`)
    if (!resp.ok) continue

    const fileData = (await resp.json()) as {
      content?: string
      encoding?: string
      name: string
    }

    if (!fileData.content || fileData.encoding !== 'base64') continue

    // Decode base64 content
    let pkgJson: Record<string, unknown>
    try {
      const decoded = atob(fileData.content)
      pkgJson = JSON.parse(decoded)
    } catch {
      continue
    }

    // Skip if no build script
    const scripts = pkgJson.scripts as Record<string, string> | undefined
    if (!scripts || !scripts.build) continue

    // Detect framework from config files in this folder
    const folderFiles = tree
      .filter((f) => {
        const dir = f.path.substring(0, f.path.lastIndexOf('/'))
        return dir === folder || (folder === '.' && !f.path.includes('/'))
      })
      .map((f) => f.path.split('/').pop() || '')

    const config = detectConfig(folderFiles, folder)

    projects.push({
      folder,
      ...config,
    })
  }

  return projects
}

function detectConfig(
  folderFiles: string[],
  folder: string
): Omit<DetectedProject, 'folder'> {
  const frameworkRules: Array<{
    name: string
    configFiles: string[]
    buildCommand: string
    outputDir: string
  }> = [
    { name: 'next.js', configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'], buildCommand: 'next build', outputDir: 'out' },
    { name: 'vite', configFiles: ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'], buildCommand: 'vite build', outputDir: 'dist' },
    { name: 'astro', configFiles: ['astro.config.js', 'astro.config.mjs', 'astro.config.ts'], buildCommand: 'astro build', outputDir: 'dist' },
    { name: 'nuxt', configFiles: ['nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.ts'], buildCommand: 'nuxt generate', outputDir: '.output/public' },
    { name: 'gatsby', configFiles: ['gatsby-config.js', 'gatsby-config.mjs', 'gatsby-config.ts'], buildCommand: 'gatsby build', outputDir: 'public' },
    { name: 'sveltekit', configFiles: ['svelte.config.js'], buildCommand: 'vite build', outputDir: 'build' },
    { name: 'remix', configFiles: ['remix.config.js', 'remix.config.mjs', 'remix.config.ts'], buildCommand: 'remix build', outputDir: 'public' },
    { name: 'angular', configFiles: ['angular.json'], buildCommand: 'ng build', outputDir: 'dist' },
  ]

  // Detect framework from config files
  for (const fw of frameworkRules) {
    if (fw.configFiles.some((cf) => folderFiles.includes(cf))) {
      return {
        packageManager: detectPm(folderFiles),
        installCommand: detectPmInstall(folderFiles),
        buildCommand: fw.buildCommand,
        outputDir: fw.outputDir,
        framework: fw.name,
      }
    }
  }

  const pm = detectPm(folderFiles)
  return {
    packageManager: pm,
    installCommand: detectPmInstall(folderFiles),
    buildCommand: pm === 'npm' ? 'npm run build' :
                  pm === 'yarn' ? 'yarn build' :
                  pm === 'pnpm' ? 'pnpm build' :
                  'bun run build',
    outputDir: 'dist',
  }
}

function detectPm(files: string[]): string {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun'
  return 'npm'
}

function detectPmInstall(files: string[]): string {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm install'
  if (files.includes('yarn.lock')) return 'yarn install'
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun install'
  return 'npm install'
}

// Quick framework detection from root files only (used for repo browser badges)
const QUICK_FRAMEWORKS = [
  { name: 'Next.js', configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'], color: '#000000' },
  { name: 'Vite', configFiles: ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'], color: '#646CFF' },
  { name: 'Astro', configFiles: ['astro.config.js', 'astro.config.mjs', 'astro.config.ts'], color: '#FF5A03' },
  { name: 'Nuxt', configFiles: ['nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.ts'], color: '#00DC82' },
  { name: 'Gatsby', configFiles: ['gatsby-config.js', 'gatsby-config.mjs', 'gatsby-config.ts'], color: '#663399' },
  { name: 'SvelteKit', configFiles: ['svelte.config.js'], color: '#FF3E00' },
  { name: 'Remix', configFiles: ['remix.config.js', 'remix.config.mjs', 'remix.config.ts'], color: '#121212' },
  { name: 'Angular', configFiles: ['angular.json'], color: '#DD0031' },
  { name: 'React', configFiles: [], color: '#61DAFB' }, // fallback: has react in deps
]

export async function quickDetectFramework(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<{ framework: string | null; color: string | null; pm: string }> {
  const contents = await listContents(token, owner, repo, '')
  const fileNames = contents.filter((c) => c.type === 'file').map((c) => c.name)

  // Detect framework from config files
  for (const fw of QUICK_FRAMEWORKS) {
    if (fw.configFiles.length > 0 && fw.configFiles.some((cf) => fileNames.includes(cf))) {
      return { framework: fw.name, color: fw.color, pm: detectPm(fileNames) }
    }
  }

  // Check if has package.json — then it's likely a Node project (show "Static" or generic)
  if (fileNames.includes('package.json')) {
    // Try to read package.json to check for React dependency
    try {
      const resp = await ghFetch(token, `/repos/${owner}/${repo}/contents/package.json`)
      if (resp.ok) {
        const data = (await resp.json()) as { content?: string; encoding?: string }
        if (data.content && data.encoding === 'base64') {
          const pkg = JSON.parse(atob(data.content.replace(/\s/g, '')))
          const deps = { ...pkg.dependencies, ...pkg.devDependencies }
          if (deps.react || deps['react-dom']) {
            return { framework: 'React', color: '#61DAFB', pm: detectPm(fileNames) }
          }
        }
      }
    } catch {}
    return { framework: null, color: null, pm: detectPm(fileNames) }
  }

  // Static HTML site (has index.html or .html files)
  const hasHtml = fileNames.some((f) => f.endsWith('.html'))
  if (hasHtml) {
    return { framework: 'Static HTML', color: '#E34F26', pm: 'none' }
  }

  return { framework: null, color: null, pm: detectPm(fileNames) }
}

export async function quickDetectBatch(
  token: string,
  repos: Array<{ owner: string; name: string; branch: string }>
): Promise<Record<string, { framework: string | null; color: string | null; pm: string }>> {
  const results: Record<string, { framework: string | null; color: string | null; pm: string }> = {}
  // Run in parallel, limit concurrency to avoid rate limits
  const chunks = []
  for (let i = 0; i < repos.length; i += 5) {
    chunks.push(repos.slice(i, i + 5))
  }
  for (const chunk of chunks) {
    const batch = await Promise.allSettled(
      chunk.map(async (r) => {
        const key = `${r.owner}/${r.name}`
        try {
          const result = await quickDetectFramework(token, r.owner, r.name, r.branch)
          results[key] = result
        } catch {
          results[key] = { framework: null, color: null, pm: 'unknown' }
        }
      })
    )
  }
  return results
}
