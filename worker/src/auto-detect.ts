import type { BuildConfig } from './types'

interface GithubTreeItem {
  path: string
  type: 'blob' | 'tree'
}

interface GithubContentsItem {
  name: string
  type: 'file' | 'dir'
  path: string
}

const FRAMEWORK_DETECT: Array<{
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

const PKG_MANAGERS: Array<{
  name: BuildConfig['packageManager']
  lockFile: string
  installCommand: string
  defaultBuild: string
}> = [
  { name: 'pnpm', lockFile: 'pnpm-lock.yaml', installCommand: 'pnpm install', defaultBuild: 'pnpm build' },
  { name: 'yarn', lockFile: 'yarn.lock', installCommand: 'yarn install', defaultBuild: 'yarn build' },
  { name: 'bun', lockFile: 'bun.lockb', installCommand: 'bun install', defaultBuild: 'bun run build' },
  { name: 'npm', lockFile: 'package-lock.json', installCommand: 'npm install', defaultBuild: 'npm run build' },
]

function extractRepoPath(url: string): string {
  // https://github.com/owner/repo -> owner/repo
  // https://github.com/owner/repo.git -> owner/repo
  // https://github.com/owner/repo/tree/branch/path -> owner/repo
  const match = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/)
  return match ? match[1] : ''
}

async function fetchGithubContents(repoUrl: string, branch: string, path = ''): Promise<GithubContentsItem[]> {
  const repoPath = extractRepoPath(repoUrl)
  if (!repoPath) return []

  const apiUrl = path
    ? `https://api.github.com/repos/${repoPath}/contents/${path}?ref=${branch}`
    : `https://api.github.com/repos/${repoPath}/contents?ref=${branch}`

  const response = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'polar-worker',
    },
  })

  if (!response.ok) return []
  const data = (await response.json()) as GithubContentsItem | GithubContentsItem[]

  if (!Array.isArray(data)) return []
  return data
}

async function detectFromContents(contents: GithubContentsItem[]): Promise<BuildConfig | null> {
  const fileNames = contents.filter((c) => c.type === 'file').map((c) => c.name)

  // Detect package manager
  let pkg: (typeof PKG_MANAGERS)[number] | undefined
  for (const pm of PKG_MANAGERS) {
    if (fileNames.includes(pm.lockFile)) {
      pkg = pm
      break
    }
  }
  // Check bun.lock as alternative bun lockfile name
  if (!pkg && fileNames.includes('bun.lock')) {
    pkg = PKG_MANAGERS[2] // bun entry
  }
  // Default to npm if no lock file found
  if (!pkg) pkg = PKG_MANAGERS[PKG_MANAGERS.length - 1]

  // Detect framework
  let framework: (typeof FRAMEWORK_DETECT)[number] | undefined
  for (const fw of FRAMEWORK_DETECT) {
    if (fw.configFiles.some((cf) => fileNames.includes(cf))) {
      framework = fw
      break
    }
  }

  // Default to generic if no framework detected
  const buildCommand = framework?.buildCommand || pkg.defaultBuild
  const outputDir = framework?.outputDir || 'dist'

  // Detect base directory (monorepo)
  const baseDir = fileNames.includes('package.json') ? '.' : '.'

  return {
    packageManager: pkg.name,
    installCommand: pkg.installCommand,
    buildCommand,
    outputDir,
    baseDir,
    framework: framework?.name,
  }
}

export async function detectFromGithubApi(
  repoUrl: string,
  branch: string
): Promise<BuildConfig | null> {
  const contents = await fetchGithubContents(repoUrl, branch)
  if (contents.length === 0) return null
  return detectFromContents(contents)
}

export { FRAMEWORK_DETECT, PKG_MANAGERS }
