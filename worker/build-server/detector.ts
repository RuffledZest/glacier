import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

interface DetectedConfig {
  packageManager: string
  installCommand: string
  buildCommand: string
  outputDir: string
  baseDir: string
  framework?: string
}

interface FrameworkRule {
  name: string
  configFiles: string[]
  buildCommand: string
  outputDir: string
}

const FRAMEWORKS: FrameworkRule[] = [
  { name: 'next.js', configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'], buildCommand: 'next build', outputDir: 'out' },
  { name: 'vite', configFiles: ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'], buildCommand: 'vite build', outputDir: 'dist' },
  { name: 'astro', configFiles: ['astro.config.js', 'astro.config.mjs', 'astro.config.ts'], buildCommand: 'astro build', outputDir: 'dist' },
  { name: 'nuxt', configFiles: ['nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.ts'], buildCommand: 'nuxt generate', outputDir: '.output/public' },
  { name: 'gatsby', configFiles: ['gatsby-config.js', 'gatsby-config.mjs', 'gatsby-config.ts'], buildCommand: 'gatsby build', outputDir: 'public' },
  { name: 'sveltekit', configFiles: ['svelte.config.js'], buildCommand: 'vite build', outputDir: 'build' },
  { name: 'remix', configFiles: ['remix.config.js', 'remix.config.mjs', 'remix.config.ts'], buildCommand: 'remix build', outputDir: 'public' },
  { name: 'angular', configFiles: ['angular.json'], buildCommand: 'ng build', outputDir: 'dist' },
]

interface PkgManager {
  name: string
  lockFile: string
  installCommand: string
  defaultBuild: string
}

const PKG_MANAGERS: PkgManager[] = [
  { name: 'pnpm', lockFile: 'pnpm-lock.yaml', installCommand: 'pnpm install', defaultBuild: 'pnpm build' },
  { name: 'yarn', lockFile: 'yarn.lock', installCommand: 'yarn install', defaultBuild: 'yarn build' },
  { name: 'bun', lockFile: 'bun.lockb', installCommand: 'bun install', defaultBuild: 'bun run build' },
  { name: 'npm', lockFile: 'package-lock.json', installCommand: 'npm install', defaultBuild: 'npm run build' },
]

function detectPackageManager(dir: string): PkgManager {
  for (const pm of PKG_MANAGERS) {
    if (existsSync(join(dir, pm.lockFile))) {
      return pm
    }
  }
  // Check bun.lock as alternative
  if (existsSync(join(dir, 'bun.lock'))) {
    return PKG_MANAGERS[2] // bun
  }
  // Default to npm
  return PKG_MANAGERS[PKG_MANAGERS.length - 1]
}

function detectFrameworkFromFiles(dir: string): FrameworkRule | null {
  const files = listFiles(dir)
  for (const fw of FRAMEWORKS) {
    if (fw.configFiles.some((cf) => files.includes(cf))) {
      return fw
    }
  }
  return null
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return existsSync(join(dir, f)) && !f.startsWith('.')
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

export function detectFramework(dir: string): DetectedConfig {
  const pkg = detectPackageManager(dir)
  const framework = detectFrameworkFromFiles(dir)

  const buildCommand = framework?.buildCommand || pkg.defaultBuild
  const outputDir = framework?.outputDir || 'dist'

  // Check package.json scripts for custom build command
  const pkgJsonPath = join(dir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      if (pkgJson.scripts?.build) {
        // Use the existing build script if framework didn't override it
        // Framework detection takes priority over generic build script
        if (!framework && pkgJson.scripts.build !== pkg.defaultBuild) {
          // Keep the generic build command, user can override
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }

  return {
    packageManager: pkg.name,
    installCommand: pkg.installCommand,
    buildCommand,
    outputDir,
    baseDir: '.',
    framework: framework?.name,
  }
}
