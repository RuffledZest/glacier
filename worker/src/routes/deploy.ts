import { Hono } from 'hono'
import { getContainer } from '@cloudflare/containers'
import type { Env } from '..'
import { verifyJwt } from '../auth'
import { timedContainerFetch } from '../container-fetch'
import {
  createDeployment,
  updateDeployment,
  touchDeployment,
  getDeployment,
  getDeployments,
  getDb,
  upsertProject,
  getProjects,
  getProject,
  deleteProject,
  getDeploymentsByRepo,
  getProjectByRepo,
} from '../db'
import type { DeployRequest, BuildRequest, DeployCommand } from '../types'
import { detectFromGithubApi } from '../auto-detect'
import { resolveMainnetEpochs, resolveTestnetEpochs } from '../epochs'
import { coerceRelativeOutputDir } from '../output-dir'

const router = new Hono<{ Bindings: Env }>()

router.post('/deploy', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const body = await c.req.json<DeployRequest>()
  const { repoUrl, branch = 'main', network = 'testnet' } = body

  if (!repoUrl) {
    return c.json({ error: 'repoUrl is required' }, 400)
  }

  if (!repoUrl.startsWith('https://github.com/')) {
    return c.json({ error: 'only GitHub repositories are supported' }, 400)
  }

  if (network !== 'mainnet' && network !== 'testnet') {
    return c.json({ error: 'network must be mainnet or testnet' }, 400)
  }

  let epochs: number
  if (network === 'mainnet') {
    const r = resolveMainnetEpochs(body.epochs)
    if (!r.ok) return c.json({ error: r.error }, 400)
    epochs = r.epochs
  } else {
    epochs = resolveTestnetEpochs(body.epochs)
  }

  let baseDir = body.baseDir || '.'
  let installCommand = body.installCommand
  let buildCommand = body.buildCommand
  let outputDir = body.outputDir
  let framework: string | undefined

  if (!installCommand || !buildCommand || !outputDir) {
    try {
      const detected = await detectFromGithubApi(repoUrl, branch)
      if (detected) {
        baseDir = body.baseDir || detected.baseDir
        installCommand = body.installCommand || detected.installCommand
        buildCommand = body.buildCommand || detected.buildCommand
        outputDir = body.outputDir || detected.outputDir
        framework = detected.framework
      }
    } catch {
      // Detection failed — will retry post-clone in container
    }
  }

  const normalizedOutputDir = coerceRelativeOutputDir(outputDir ?? null, baseDir) ?? outputDir ?? null

  // Upsert project with build config
  await upsertProject(db, {
    userAddress: payload.address as string,
    repoUrl,
    branch,
    baseDir,
    installCommand: installCommand || null,
    buildCommand: buildCommand || null,
    outputDir: normalizedOutputDir,
    network,
  })

  const deploymentId = crypto.randomUUID()

  await createDeployment(db, {
    id: deploymentId,
    userAddress: payload.address as string,
    repoUrl,
    branch,
    baseDir,
    installCommand: installCommand || null,
    buildCommand: buildCommand || null,
    outputDir: normalizedOutputDir,
    network,
    status: 'queued',
    error: null,
    objectId: null,
    base36Url: null,
    logs: '',
  })

  c.executionCtx.waitUntil(
    runBuildAndDeploy(
      c.env,
      db,
      deploymentId,
      repoUrl,
      branch,
      baseDir,
      installCommand,
      buildCommand,
      normalizedOutputDir ?? undefined,
      network,
      epochs,
      body.siteName
    )
  )

  return c.json({
    id: deploymentId,
    status: 'queued',
    detected: framework
      ? { framework, baseDir, installCommand, buildCommand, outputDir: normalizedOutputDir ?? outputDir }
      : null,
  }, 202)
})

router.get('/deployments/:id', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const id = c.req.param('id')
  const deployment = await getDeployment(db, id)

  if (!deployment) {
    return c.json({ error: 'deployment not found' }, 404)
  }

  if (deployment.userAddress !== (payload.address as string)) {
    return c.json({ error: 'not authorized' }, 403)
  }

  return c.json(deployment)
})

router.post('/deployments/:id/retry', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const id = c.req.param('id')
  const deployment = await getDeployment(db, id)

  if (!deployment) {
    return c.json({ error: 'deployment not found' }, 404)
  }

  if (deployment.userAddress !== (payload.address as string)) {
    return c.json({ error: 'not authorized' }, 403)
  }

  if (deployment.status !== 'failed') {
    return c.json({ error: 'only failed deployments can be retried' }, 400)
  }

  // Get project config (latest) for retry
  const project = await getProjectByRepo(db, payload.address as string, deployment.repoUrl)

  const retryId = crypto.randomUUID()

  const retryConfig = project || deployment
  const retryBase = retryConfig.baseDir || '.'
  const safeOutputDir =
    coerceRelativeOutputDir(retryConfig.outputDir, retryBase) ??
    coerceRelativeOutputDir(deployment.outputDir, deployment.baseDir || '.') ??
    'dist'

  await createDeployment(db, {
    id: retryId,
    userAddress: payload.address as string,
    repoUrl: deployment.repoUrl,
    branch: retryConfig.branch,
    baseDir: retryConfig.baseDir,
    installCommand: retryConfig.installCommand,
    buildCommand: retryConfig.buildCommand,
    outputDir: safeOutputDir,
    network: retryConfig.network,
    status: 'queued',
    error: null,
    objectId: null,
    base36Url: null,
    logs: '',
  })

  c.executionCtx.waitUntil(
    runBuildAndDeploy(
      c.env,
      db,
      retryId,
      deployment.repoUrl,
      retryConfig.branch,
      retryConfig.baseDir || '.',
      retryConfig.installCommand || undefined,
      retryConfig.buildCommand || undefined,
      safeOutputDir,
      deployment.network,
      deployment.network === 'mainnet' ? 2 : 1,
      undefined
    )
  )

  return c.json({ id: retryId, status: 'queued' }, 202)
})

// GET /api/deployments/:id/logs — SSE live log stream
router.get('/deployments/:id/logs', async (c) => {
  const db = getDb(c)

  const token = c.req.query('token') || ''
  const payload = token ? await verifyJwt(token, c.env.JWT_SECRET) : null
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const id = c.req.param('id')
  const deployment = await getDeployment(db, id)
  if (!deployment || deployment.userAddress !== (payload.address as string)) {
    return c.json({ error: 'not found' }, 404)
  }

  // If build is not active, serve logs from D1
  if (!['building', 'deploying'].includes(deployment.status)) {
    return c.json({ logs: deployment.logs })
  }

  // Stream logs from the container via SSE
  try {
    const container = getContainer(c.env.BUILD_CONTAINER, id)
    await container.startAndWaitForPorts({ cancellationOptions: { portReadyTimeoutMS: 10000 } })

    const sseResp = await timedContainerFetch(
      container,
      new Request('http://localhost/stream-logs/' + encodeURIComponent(id)),
      0,
    )

    if (!sseResp.ok || !sseResp.body) {
      return c.json({ logs: deployment.logs })
    }

    const reader = sseResp.body.getReader()

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
          } else {
            controller.enqueue(value)
          }
        } catch {
          controller.close()
        }
      },
      cancel() {
        reader.cancel()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    })
  } catch {
    return c.json({ logs: deployment.logs })
  }
})

router.get('/deployments', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const limit = Number(c.req.query('limit')) || 20
  const offset = Number(c.req.query('offset')) || 0
  const deployments = await getDeployments(db, payload.address as string, limit, offset)
  return c.json({ deployments })
})

// ── Projects ──

router.get('/projects', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const projects = await getProjects(db, payload.address as string)
  return c.json({ projects })
})

router.get('/projects/:id', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const id = c.req.param('id')
  const project = await getProject(db, id)

  if (!project) {
    return c.json({ error: 'project not found' }, 404)
  }

  if (project.userAddress !== (payload.address as string)) {
    return c.json({ error: 'not authorized' }, 403)
  }

  const deployments = await getDeploymentsByRepo(db, payload.address as string, project.repoUrl)

  return c.json({ project, deployments })
})

router.delete('/projects/:id', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const id = c.req.param('id')
  await deleteProject(db, id, payload.address as string)
  return c.json({ success: true })
})

router.delete('/deployments/:id', async (c) => {
  const db = getDb(c)

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token, c.env.JWT_SECRET)
  if (!payload) {
    return c.json({ error: 'invalid or expired token' }, 401)
  }

  const id = c.req.param('id')
  const deployment = await getDeployment(db, id)

  if (!deployment) {
    return c.json({ error: 'deployment not found' }, 404)
  }

  if (deployment.userAddress !== (payload.address as string)) {
    return c.json({ error: 'not authorized' }, 403)
  }

  await updateDeployment(db, id, { status: 'deleted' })
  return c.json({ ok: true })
})

async function runBuildAndDeploy(
  env: Env,
  db: D1Database,
  deploymentId: string,
  repoUrl: string,
  branch: string,
  baseDir: string,
  installCommand: string | undefined,
  buildCommand: string | undefined,
  outputDir: string | undefined,
  network: 'mainnet' | 'testnet',
  epochs: number,
  siteName?: string
): Promise<void> {
  try {
    await updateDeployment(db, deploymentId, { status: 'building' })

    const effectiveOutputDir =
      coerceRelativeOutputDir(outputDir ?? null, baseDir || '.') ?? outputDir

    const container = getContainer(env.BUILD_CONTAINER, deploymentId)

    // Ensure container is started before sending requests
    await container.startAndWaitForPorts({
      cancellationOptions: { portReadyTimeoutMS: 30000 },
    })

    // Phase 1: Start async build
    const buildReq: BuildRequest = {
      repoUrl,
      branch,
      baseDir,
      installCommand,
      buildCommand,
      outputDir: effectiveOutputDir,
      githubToken: env.GITHUB_TOKEN || undefined,
      buildId: deploymentId,
    }

    const startResp = await timedContainerFetch(
      container,
      new Request('http://localhost/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReq),
      }),
    )

    if (!startResp.ok) {
      const text = await startResp.text().catch(() => '')
      await updateDeployment(db, deploymentId, {
        status: 'failed',
        error: `container returned ${startResp.status}: ${text.slice(0, 500)}`,
      })
      return
    }

    let startData: { buildId?: string; error?: string }
    try { startData = await startResp.json() } catch {
      await updateDeployment(db, deploymentId, { status: 'failed', error: 'invalid JSON from build start' })
      return
    }

    if (!startData.buildId) {
      await updateDeployment(db, deploymentId, { status: 'failed', error: startData.error || 'build start failed' })
      return
    }

    const buildId = startData.buildId

    // Phase 2: Poll logs and status until build completes
    let lastLogLen = 0
    let pollCount = 0
    while (pollCount < 300) { // 10 minute timeout
      pollCount++
      await new Promise((r) => setTimeout(r, 2000))

      // Heartbeat so Updated At / UI show the worker is still polling (Vite may not print for a long time).
      if (pollCount % 3 === 0) {
        try {
          await touchDeployment(db, deploymentId)
        } catch { /* ignore */ }
      }

      // Fetch latest logs
      try {
        const logResp = await timedContainerFetch(container, new Request(`http://localhost/logs/${buildId}`))
        if (logResp.ok) {
          const logData = await logResp.json() as { logs: string }
          if (logData.logs && logData.logs.length > lastLogLen) {
            await updateDeployment(db, deploymentId, { logs: logData.logs })
            lastLogLen = logData.logs.length
          }
        }
      } catch { /* ignore poll errors */ }

      // Check build status
      try {
        const statusResp = await timedContainerFetch(container, new Request(`http://localhost/status/${buildId}`))
        if (statusResp.ok) {
          const state = await statusResp.json() as {
            status: string
            distPath?: string
            error?: string
            detectedConfig?: { outputDir?: string }
          }
          if (state.status === 'done' && state.distPath) {
            // Update logs one final time
            const finalLogResp = await timedContainerFetch(container, new Request(`http://localhost/logs/${buildId}`))
            if (finalLogResp.ok) {
              const finalLogData = await finalLogResp.json() as { logs: string }
              if (finalLogData.logs) await updateDeployment(db, deploymentId, { logs: finalLogData.logs })
            }

            const builtOutput =
              state.detectedConfig?.outputDir ??
              coerceRelativeOutputDir(state.distPath, baseDir || '.') ??
              'dist'
            await updateDeployment(db, deploymentId, { status: 'built', outputDir: builtOutput })
            break
          }
          if (state.status === 'error') {
            const logResp = await timedContainerFetch(container, new Request(`http://localhost/logs/${buildId}`))
            let logs = ''
            if (logResp.ok) { const d = await logResp.json() as { logs: string }; logs = d.logs }
            await updateDeployment(db, deploymentId, { status: 'failed', error: state.error || 'build failed', logs })
            return
          }
        }
      } catch { /* ignore */ }
    }

    // Get current state after polling loop
    const finalStatusResp = await timedContainerFetch(container, new Request(`http://localhost/status/${buildId}`))
    if (!finalStatusResp.ok) {
      await updateDeployment(db, deploymentId, { status: 'failed', error: 'build status check failed' })
      return
    }

    const finalState = await finalStatusResp.json() as { status: string; distPath?: string; error?: string; detectedConfig?: { framework?: string } }
    if (finalState.status !== 'done' || !finalState.distPath) {
      await updateDeployment(db, deploymentId, { status: 'failed', error: finalState.error || 'build timed out or failed' })
      return
    }

    const distPath = finalState.distPath
    await updateDeployment(db, deploymentId, { status: 'built' })

    // Phase 3: Deploy
    await updateDeployment(db, deploymentId, { status: 'deploying' })

    // Ensure container is still running before deploy (it may have shut down after build)
    await container.startAndWaitForPorts({
      cancellationOptions: { portReadyTimeoutMS: 30000 },
    })

    const deployCmd: DeployCommand = {
      distPath,
      network,
      epochs,
      siteName,
      suiKeystore: (env.SUI_KEYSTORE as string) || '',
      suiAddress: (env.SUI_ADDRESS as string) || '',
      buildId: deploymentId,
    }

    // Poll deploy logs in background so frontend sees live updates
    let deployLogLen = 0
    const logPollInterval = setInterval(async () => {
      try {
        const logResp = await timedContainerFetch(container, new Request(`http://localhost/logs/${deploymentId}`))
        if (logResp.ok) {
          const logData = await logResp.json() as { logs: string }
          if (logData.logs && logData.logs.length > deployLogLen) {
            await updateDeployment(db, deploymentId, { logs: logData.logs })
            deployLogLen = logData.logs.length
          }
        }
      } catch { /* ignore poll errors */ }
    }, 3000)

    const deployHeartbeat = setInterval(() => {
      void touchDeployment(db, deploymentId)
    }, 8000)

    const clearDeployPollers = () => {
      clearInterval(logPollInterval)
      clearInterval(deployHeartbeat)
    }

    let deployResult: { success: boolean; objectId?: string; base36Url?: string; error?: string; logs?: string[] }
    try {
      const deployResponse = await timedContainerFetch(
        container,
        new Request('http://localhost/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(deployCmd),
        }),
        0,
      )

      if (!deployResponse.ok) {
        const text = await deployResponse.text().catch(() => '')
        clearDeployPollers()
        await updateDeployment(db, deploymentId, {
          status: 'failed',
          error: `container deploy returned ${deployResponse.status}: ${text.slice(0, 500)}`,
        })
        return
      }

      try {
        deployResult = await deployResponse.json()
      } catch {
        const text = await deployResponse.clone().text().catch(() => 'unknown')
        clearDeployPollers()
        await updateDeployment(db, deploymentId, {
          status: 'failed',
          error: `invalid JSON from container deploy: ${text.slice(0, 500)}`,
        })
        return
      }
    } catch (fetchErr) {
      clearDeployPollers()
      const errMsg = fetchErr instanceof Error ? fetchErr.message : 'deploy fetch failed'
      await updateDeployment(db, deploymentId, {
        status: 'failed',
        error: `Deploy connection failed: ${errMsg}. The deployment may have been too large or timed out.`,
      })
      return
    }

    clearDeployPollers()

    // Final log sync
    try {
      const finalLogResp = await timedContainerFetch(container, new Request(`http://localhost/logs/${deploymentId}`))
      if (finalLogResp.ok) {
        const finalLogData = await finalLogResp.json() as { logs: string }
        if (finalLogData.logs) await updateDeployment(db, deploymentId, { logs: finalLogData.logs })
      }
    } catch { /* ignore */ }

    if (!deployResult.success) {
      const current = await getDeployment(db, deploymentId)
      const deployLogs = Array.isArray(deployResult.logs) ? deployResult.logs.join('\n') : String(deployResult.logs || '')
      const combinedLogs = (current?.logs || '') + '\n--- Deploy ---\n' + deployLogs
      await updateDeployment(db, deploymentId, {
        status: 'failed',
        error: deployResult.error || 'deploy failed',
        logs: combinedLogs,
      })
      return
    }

    const current = await getDeployment(db, deploymentId)
    const deployLogs = Array.isArray(deployResult.logs) ? deployResult.logs.join('\n') : String(deployResult.logs || '')
    const combinedLogs = (current?.logs || '') + '\n--- Deploy ---\n' + deployLogs
    await updateDeployment(db, deploymentId, {
      status: 'deployed',
      objectId: deployResult.objectId || null,
      base36Url: deployResult.base36Url || null,
      logs: combinedLogs,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'unknown error'
    await updateDeployment(db, deploymentId, {
      status: 'failed',
      error: errorMessage,
    })
  }
}

export default router
