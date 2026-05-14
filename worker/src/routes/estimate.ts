import { Hono } from 'hono'
import { getContainer } from '@cloudflare/containers'
import type { Env } from '..'
import { verifyJwt } from '../auth'
import type { BuildRequest } from '../types'
import { detectFromGithubApi } from '../auto-detect'
import { resolveMainnetEpochs, resolveTestnetEpochs } from '../epochs'

const router = new Hono<{ Bindings: Env }>()

// Approximate Walrus pricing (may vary by network conditions)
const WAL_PER_GIB_PER_EPOCH = 1.0
const SUI_GAS_ESTIMATE = 0.001

router.post('/estimate', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const body = await c.req.json<BuildRequest & { epochs?: number | 'max'; network?: 'mainnet' | 'testnet' }>()
  const { repoUrl, branch = 'main', network = 'testnet' } = body

  if (!repoUrl) return c.json({ error: 'repoUrl is required' }, 400)
  if (!repoUrl.startsWith('https://github.com/')) return c.json({ error: 'only GitHub repositories are supported' }, 400)

  let epochCount: number
  if (network === 'mainnet') {
    const r = resolveMainnetEpochs(body.epochs)
    if (!r.ok) return c.json({ error: r.error }, 400)
    epochCount = r.epochs
  } else {
    epochCount = resolveTestnetEpochs(body.epochs)
  }

  let baseDir = body.baseDir || '.'
  let installCommand = body.installCommand
  let buildCommand = body.buildCommand
  let outputDir = body.outputDir

  if (!installCommand || !buildCommand || !outputDir) {
    try {
      const detected = await detectFromGithubApi(repoUrl, branch)
      if (detected) {
        baseDir = body.baseDir || detected.baseDir
        installCommand = body.installCommand || detected.installCommand
        buildCommand = body.buildCommand || detected.buildCommand
        outputDir = body.outputDir || detected.outputDir
      }
    } catch {}
  }

  const estimateId = crypto.randomUUID()

  async function readContainerLogs(container: ReturnType<typeof getContainer>): Promise<string> {
    try {
      const logResp = await container.fetch(new Request(`http://localhost/logs/${estimateId}`))
      if (!logResp.ok) return ''
      const data = await logResp.json() as { logs?: string }
      return (data.logs || '').slice(-500_000)
    } catch {
      return ''
    }
  }

  try {
    const container = getContainer(c.env.BUILD_CONTAINER, estimateId)
    await container.startAndWaitForPorts({
      cancellationOptions: { portReadyTimeoutMS: 30000 },
    })

    const buildReq: BuildRequest = {
      repoUrl,
      branch,
      baseDir,
      installCommand,
      buildCommand,
      outputDir,
      githubToken: c.env.GITHUB_TOKEN || undefined,
      buildId: estimateId,
    }

    const startResp = await container.fetch(
      new Request('http://localhost/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReq),
      })
    )

    if (!startResp.ok) {
      const text = await startResp.text().catch(() => '')
      return c.json({ error: `build start failed: ${text.slice(0, 300)}` }, 500)
    }

    const startData = await startResp.json() as { buildId?: string; error?: string }
    if (!startData.buildId) {
      return c.json({ error: startData.error || 'build start failed' }, 500)
    }

    // Poll for completion
    let pollCount = 0
    let distPath: string | undefined
    let fileCount = 0
    let totalBytes = 0
    let error: string | undefined

    while (pollCount < 300) {
      pollCount++
      await new Promise((r) => setTimeout(r, 2000))

      try {
        const statusResp = await container.fetch(
          new Request(`http://localhost/status/${estimateId}`)
        )
        if (statusResp.ok) {
          const state = await statusResp.json() as {
            status: string; distPath?: string; error?: string
            fileCount?: number; totalBytes?: number
          }
          if (state.status === 'done' && state.distPath) {
            distPath = state.distPath
            fileCount = state.fileCount || 0
            totalBytes = state.totalBytes || 0
            break
          }
          if (state.status === 'error') {
            error = state.error || 'build failed'
            break
          }
        }
      } catch {}
    }

    if (error || !distPath) {
      const logs = await readContainerLogs(container)
      return c.json({ error: error || 'build timed out or failed', logs }, 500)
    }

    const logs = await readContainerLogs(container)

    const sizeGib = totalBytes / (1024 * 1024 * 1024)
    const estimatedWal = sizeGib * epochCount * WAL_PER_GIB_PER_EPOCH

    return c.json({
      buildId: estimateId,
      distPath,
      fileCount,
      totalBytes,
      sizeGib: Math.max(sizeGib, 0.0001),
      epochs: epochCount,
      network,
      estimatedWal: Math.max(estimatedWal, 0.0001),
      estimatedSuiGas: SUI_GAS_ESTIMATE,
      formula: `${WAL_PER_GIB_PER_EPOCH} WAL/GiB/epoch × ${sizeGib.toFixed(4)} GiB × ${epochCount} epochs`,
      logs,
    })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'estimation failed',
    }, 500)
  }
})

export default router
