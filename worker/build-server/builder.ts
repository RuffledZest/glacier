import { spawn, ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, appendFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { detectFramework } from './detector.js'

interface BuildParams {
  repoUrl: string
  branch: string
  baseDir?: string
  installCommand?: string
  buildCommand?: string
  outputDir?: string
  githubToken?: string
}

interface BuildResult {
  success: boolean
  distPath?: string
  error?: string
  logs: string[]
  detectedConfig?: {
    packageManager: string
    installCommand: string
    buildCommand: string
    outputDir: string
    baseDir: string
    framework?: string
  }
}

interface BuildState {
  status: 'pending' | 'running' | 'done' | 'error'
  distPath?: string
  error?: string
  fileCount?: number
  totalBytes?: number
  detectedConfig?: BuildResult['detectedConfig']
}

const WORKSPACE = '/tmp/builds'

const DANGEROUS_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish',
  '.py', '.pyc', '.rb', '.pl',
  '.php', '.phtml', '.asp', '.aspx', '.jsp',
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.vbs',
  '.dll', '.so', '.dylib',
  '.cgi', '.fcgi',
  '.jar', '.war',
  '.node',
])

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB cap on build log file

function safeAppend(logPath: string, data: string): void {
  try {
    const current = statSync(logPath).size
    if (current >= MAX_LOG_SIZE) {
      // Drop new data once cap is reached to prevent unbounded growth
      return
    }
    const remaining = MAX_LOG_SIZE - current
    appendFileSync(logPath, data.length > remaining ? data.slice(0, remaining) + '\n[log truncated: exceeded 10MB max]\n' : data)
  } catch {
    appendFileSync(logPath, data)
  }
}

function childEnv(phase: 'clone' | 'install' | 'build'): NodeJS.ProcessEnv {
  const { NODE_ENV: _drop, ...rest } = process.env
  const base: NodeJS.ProcessEnv = { ...rest, HOME: '/root', PATH: process.env.PATH }
  if (phase === 'install') {
    // Image sets NODE_ENV=production; npm omits devDependencies in that case. Install needs tsc/vite/etc.
    return base
  }
  if (phase === 'build') {
    // CI encourages line-oriented tool output (npm/vite) so logs flush during long bundle steps.
    return { ...base, NODE_ENV: 'production', CI: 'true' }
  }
  return base
}

function runAsync(cmd: string, cwd: string, logPath: string, phase: 'clone' | 'install' | 'build'): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, { shell: true, cwd, env: childEnv(phase) })
    proc.stdout.on('data', (d: Buffer) => safeAppend(logPath, d.toString()))
    proc.stderr.on('data', (d: Buffer) => safeAppend(logPath, d.toString()))
    proc.on('close', (code) => resolve({ exitCode: code ?? 1 }))
    proc.on('error', () => resolve({ exitCode: 1 }))
  })
}

function readLogs(buildId: string): string {
  const logPath = join(WORKSPACE, buildId, 'log.txt')
  try { return readFileSync(logPath, 'utf-8') } catch { return '' }
}

function writeState(buildId: string, state: BuildState): void {
  writeFileSync(join(WORKSPACE, buildId, 'state.json'), JSON.stringify(state))
}

function readState(buildId: string): BuildState {
  try { return JSON.parse(readFileSync(join(WORKSPACE, buildId, 'state.json'), 'utf-8')) } catch { return { status: 'pending' } }
}

function sanitizeGitConfig(repoDir: string, token: string): void {
  const gitConfigPath = join(repoDir, '.git', 'config')
  if (!existsSync(gitConfigPath)) return
  try {
    let content = readFileSync(gitConfigPath, 'utf-8')
    content = content.replace(new RegExp(`https://${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@github\\.com`, 'g'), 'https://github.com')
    writeFileSync(gitConfigPath, content)
  } catch { /* best effort */ }
}

function verifyStaticSite(dir: string): string | null {
  const violations: string[] = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    let entries; try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const fp = join(current, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') stack.push(fp); continue }
      if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (DANGEROUS_EXTENSIONS.has(ext)) violations.push(`${fp} (dangerous extension: ${ext})`)
        try { if ((statSync(fp).mode & 0o111) !== 0) violations.push(`${fp} (executable)`) } catch {}
      }
    }
  }
  return violations.length ? `non-static files detected:\n${violations.join('\n')}` : null
}

function detectBaseDir(repoDir: string): string {
  const entries = readdirSync(repoDir, { withFileTypes: true })
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) return '.'
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(repoDir, entry.name, 'package.json'))) return entry.name
  }
  return '.'
}

function detectPackageManager(dir: string): string {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

function countFiles(dir: string): number {
  let count = 0; const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    let entries; try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isFile()) count++
      else if (entry.isDirectory() && entry.name !== 'node_modules') stack.push(join(current, entry.name))
    }
  }
  return count
}

function totalDirSize(dir: string): number {
  let bytes = 0; const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    let entries; try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const fp = join(current, entry.name)
      if (entry.isFile()) { try { bytes += statSync(fp).size } catch {} }
      else if (entry.isDirectory() && entry.name !== 'node_modules') stack.push(fp)
    }
  }
  return bytes
}

// Start a build in the background. Returns a buildId immediately.
export function startBuild(params: BuildParams & { buildId?: string }): string {
  const buildId = params.buildId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const buildDir = join(WORKSPACE, buildId)
  mkdirSync(buildDir, { recursive: true })
  const logPath = join(buildDir, 'log.txt')
  writeFileSync(logPath, '')

  writeState(buildId, { status: 'running' })

  // Run build in background
  runBuildAsync(params, buildDir, logPath, buildId)

  return buildId
}

async function runBuildAsync(params: BuildParams, buildDir: string, logPath: string, buildId: string): Promise<void> {
  const log = (msg: string) => safeAppend(logPath, msg + '\n')

  const { repoUrl, branch = 'main', baseDir: baseDirOverride, installCommand: installOverride, buildCommand: buildOverride, outputDir: outputOverride, githubToken } = params

  try {
    const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repo'
    const repoDir = join(buildDir, 'repo')

    // Clone
    let cloneUrl = repoUrl
    if (githubToken) {
      cloneUrl = repoUrl.replace(/^https:\/\/[^@]+@github\.com/, 'https://github.com')
      cloneUrl = cloneUrl.replace('https://', `https://${githubToken}@`)
    }

    log(`Cloning ${repoUrl} (branch: ${branch})...`)
    const cloneResult = await runAsync(`git clone --depth 1 --single-branch --branch "${branch}" "${cloneUrl}" "${repoDir}"`, buildDir, logPath, 'clone')

    if (githubToken) sanitizeGitConfig(repoDir, githubToken)

    if (cloneResult.exitCode !== 0) {
      log('Clone failed')
      writeState(buildId, { status: 'error', error: 'git clone failed' })
      return
    }
    log('Clone complete')

    // Determine base directory
    const baseDir = baseDirOverride || detectBaseDir(repoDir)
    const workingDir = join(repoDir, baseDir)
    if (!existsSync(workingDir)) {
      log(`Base directory not found: ${baseDir}`)
      writeState(buildId, { status: 'error', error: `base directory not found: ${baseDir}` })
      return
    }

    // Detect config
    let installCommand = installOverride
    let buildCommand = buildOverride
    let outputDir = outputOverride
    let detectedFramework: string | undefined

    if (!installCommand || !buildCommand || !outputDir) {
      const detected = detectFramework(workingDir)
      log(`Detected: packageManager=${detected.packageManager}, framework=${detected.framework || 'none'}`)
      installCommand = installCommand || detected.installCommand
      buildCommand = buildCommand || detected.buildCommand
      outputDir = outputDir || detected.outputDir
      detectedFramework = detected.framework
    }

    log(`Base dir: ${baseDir}`)
    log(`Install: ${installCommand}`)
    log(`Build: ${buildCommand}`)
    log(`Output: ${outputDir}`)

    // Install
    log(`Running ${installCommand}...`)
    const installResult = await runAsync(installCommand!, workingDir, logPath, 'install')
    if (installResult.exitCode !== 0) {
      log('Install failed')
      writeState(buildId, { status: 'error', error: 'install failed' })
      return
    }
    log('Install complete')

    // Build
    log(`Running ${buildCommand}...`)
    const buildResult = await runAsync(buildCommand!, workingDir, logPath, 'build')
    if (buildResult.exitCode !== 0) {
      log('Build failed')
      writeState(buildId, { status: 'error', error: 'build failed' })
      return
    }
    log('Build complete')

    // Verify output
    const distPath = join(workingDir, outputDir!)
    if (!existsSync(distPath)) {
      log(`Output directory not found: ${outputDir}`)
      writeState(buildId, { status: 'error', error: `output directory not found: ${outputDir}` })
      return
    }

    const verificationError = verifyStaticSite(distPath)
    if (verificationError) {
      log(`Static site verification failed: ${verificationError}`)
      writeState(buildId, { status: 'error', error: verificationError })
      return
    }

    const fileCount = countFiles(distPath)
    const totalBytes = totalDirSize(distPath)
    log(`Output verified: ${distPath} (${fileCount} files, ${(totalBytes / 1024).toFixed(1)}KB, static site confirmed)`)
    log('Build successful')

    writeState(buildId, {
      status: 'done',
      distPath,
      fileCount,
      totalBytes,
      detectedConfig: {
        packageManager: detectPackageManager(workingDir),
        installCommand: installCommand!,
        buildCommand: buildCommand!,
        outputDir: outputDir!,
        baseDir,
        framework: detectedFramework,
      },
    })
  } catch (err) {
    log(`Build error: ${err instanceof Error ? err.message : 'unknown'}`)
    writeState(buildId, { status: 'error', error: err instanceof Error ? err.message : 'unknown error' })
  }
}

export { readLogs, readState, writeState, WORKSPACE }
export { detectBaseDir, detectPackageManager, countFiles, verifyStaticSite }
