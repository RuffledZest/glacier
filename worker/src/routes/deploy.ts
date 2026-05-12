import { Hono } from 'hono'
import { getContainer } from '@cloudflare/containers'
import type { Env } from '..'
import { verifyJwt } from '../auth'
import { createDeployment, updateDeployment, getDeployment, getDeployments, getDb } from '../db'
import type { DeployRequest, BuildRequest, DeployCommand } from '../types'
import { detectFromGithubApi } from '../auto-detect'

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

  // Validate epochs: testnet capped at 7, mainnet always max
  const epochs = network === 'mainnet' ? 'max' as const
    : body.epochs && body.epochs !== 'max' && (typeof body.epochs === 'number')
      ? Math.max(1, Math.min(body.epochs, 7))
      : 1

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

  const deploymentId = crypto.randomUUID()

  await createDeployment(db, {
    id: deploymentId,
    userAddress: payload.address as string,
    repoUrl,
    branch,
    baseDir,
    installCommand: installCommand || null,
    buildCommand: buildCommand || null,
    outputDir: outputDir || null,
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
      outputDir,
      network,
      epochs,
      body.siteName
    )
  )

  return c.json({
    id: deploymentId,
    status: 'queued',
    detected: framework ? { framework, baseDir, installCommand, buildCommand, outputDir } : null,
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

  const retryId = crypto.randomUUID()

  await createDeployment(db, {
    id: retryId,
    userAddress: payload.address as string,
    repoUrl: deployment.repoUrl,
    branch: deployment.branch,
    baseDir: deployment.baseDir,
    installCommand: deployment.installCommand,
    buildCommand: deployment.buildCommand,
    outputDir: deployment.outputDir,
    network: deployment.network,
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
      deployment.branch,
      deployment.baseDir,
      deployment.installCommand || undefined,
      deployment.buildCommand || undefined,
      deployment.outputDir || undefined,
      deployment.network,
      undefined,
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

    const sseResp = await container.fetch(
      new Request('http://localhost/stream-logs/' + encodeURIComponent(id))
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
  epochs?: number | 'max',
  siteName?: string
): Promise<void> {
  try {
    await updateDeployment(db, deploymentId, { status: 'building' })

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
      outputDir,
      githubToken: env.GITHUB_TOKEN || undefined,
      buildId: deploymentId,
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

      // Fetch latest logs
      try {
        const logResp = await container.fetch(new Request(`http://localhost/logs/${buildId}`))
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
        const statusResp = await container.fetch(new Request(`http://localhost/status/${buildId}`))
        if (statusResp.ok) {
          const state = await statusResp.json() as { status: string; distPath?: string; error?: string }
          if (state.status === 'done' && state.distPath) {
            // Update logs one final time
            const finalLogResp = await container.fetch(new Request(`http://localhost/logs/${buildId}`))
            if (finalLogResp.ok) {
              const finalLogData = await finalLogResp.json() as { logs: string }
              if (finalLogData.logs) await updateDeployment(db, deploymentId, { logs: finalLogData.logs })
            }

            await updateDeployment(db, deploymentId, { status: 'built', outputDir: state.distPath })
            break
          }
          if (state.status === 'error') {
            const logResp = await container.fetch(new Request(`http://localhost/logs/${buildId}`))
            let logs = ''
            if (logResp.ok) { const d = await logResp.json() as { logs: string }; logs = d.logs }
            await updateDeployment(db, deploymentId, { status: 'failed', error: state.error || 'build failed', logs })
            return
          }
        }
      } catch { /* ignore */ }
    }

    // Get current state after polling loop
    const finalStatusResp = await container.fetch(new Request(`http://localhost/status/${buildId}`))
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

    const deployResponse = await container.fetch(
      new Request('http://localhost/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deployCmd),
      })
    )

    if (!deployResponse.ok) {
      const text = await deployResponse.text().catch(() => '')
      await updateDeployment(db, deploymentId, {
        status: 'failed',
        error: `container deploy returned ${deployResponse.status}: ${text.slice(0, 500)}`,
      })
      return
    }

    let deployResult: { success: boolean; objectId?: string; base36Url?: string; error?: string; logs?: string[] }
    try {
      deployResult = await deployResponse.json()
    } catch {
      const text = await deployResponse.clone().text().catch(() => 'unknown')
      await updateDeployment(db, deploymentId, {
        status: 'failed',
        error: `invalid JSON from container deploy: ${text.slice(0, 500)}`,
      })
      return
    }

    if (!deployResult.success) {
      // Get current logs from D1 and append deploy error
      const current = await getDeployment(db, deploymentId)
      const combinedLogs = (current?.logs || '') + '\n--- Deploy ---\n' + (deployResult.logs || []).join('\n')
      await updateDeployment(db, deploymentId, {
        status: 'failed',
        error: deployResult.error || 'deploy failed',
        logs: combinedLogs,
      })
      return
    }

    const current = await getDeployment(db, deploymentId)
    const combinedLogs = (current?.logs || '') + '\n--- Deploy ---\n' + (deployResult.logs || []).join('\n')
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
