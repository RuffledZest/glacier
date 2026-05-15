import { Hono } from 'hono'
import { getContainer } from '@cloudflare/containers'
import type { Env } from '..'
import { timedContainerFetch } from '../container-fetch'
import { createDeployment, updateDeployment, touchDeployment, getDeployment, getDb, upsertProject } from '../db'
import type { BuildRequest, DeployCommand } from '../types'
import { detectFromGithubApi } from '../auto-detect'

const router = new Hono<{ Bindings: Env }>()

async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
    const computed = 'sha256=' + Array.from(new Uint8Array(sigBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    if (computed.length !== signature.length) return false

    // Constant-time comparison
    let result = 0
    const computedBytes = encoder.encode(computed)
    const sigInputBytes = encoder.encode(signature)
    for (let i = 0; i < computedBytes.length; i++) {
      result |= computedBytes[i] ^ sigInputBytes[i]
    }
    return result === 0
  } catch {
    return false
  }
}

router.post('/github', async (c) => {
  const env = c.env
  const db = getDb(c)
  const webhookSecret = env.WEBHOOK_SECRET

  const signature = c.req.header('x-hub-signature-256')
  const event = c.req.header('x-github-event')
  const deliveryId = c.req.header('x-github-delivery')

  if (!signature && webhookSecret) {
    return c.json({ error: 'missing signature' }, 401)
  }

  const rawBody = await c.req.text()

  if (webhookSecret && signature) {
    if (!(await verifySignature(rawBody, signature, webhookSecret))) {
      return c.json({ error: 'invalid signature' }, 401)
    }
  }

  if (event !== 'push') {
    return c.json({ message: 'ignored event type', event })
  }

  const payload = JSON.parse(rawBody)
  const repoUrl = payload.repository?.clone_url || payload.repository?.html_url
  const branch = (payload.ref as string)?.replace('refs/heads/', '') || 'main'
  const defaultBranch = payload.repository?.default_branch || 'main'

  if (!repoUrl) {
    return c.json({ error: 'could not determine repository URL' }, 400)
  }

  if (branch !== defaultBranch) {
    return c.json({ message: 'ignored push to non-default branch', branch, defaultBranch })
  }

  // Find user who owns this webhook by repo URL
  const existing = await db
    .prepare('SELECT user_address FROM deployments WHERE repo_url = ?1 ORDER BY created_at DESC LIMIT 1')
    .bind(repoUrl)
    .first<{ user_address: string }>()

  if (!existing) {
    return c.json({ error: 'no deployment found for this repository. deploy once manually first.' }, 404)
  }

  const userAddress = existing.user_address

  let baseDir = '.'
  let installCommand: string | undefined
  let buildCommand: string | undefined
  let outputDir: string | undefined
  const network = (env.WALRUS_NETWORK as string) || 'mainnet'

  try {
    const detected = await detectFromGithubApi(repoUrl, branch)
    if (detected) {
      baseDir = detected.baseDir
      installCommand = detected.installCommand
      buildCommand = detected.buildCommand
      outputDir = detected.outputDir
    }
  } catch {
    // Detection failed — will retry post-clone
  }

  await upsertProject(db, {
    userAddress,
    repoUrl,
    branch,
    baseDir,
    installCommand: installCommand || null,
    buildCommand: buildCommand || null,
    outputDir: outputDir || null,
    network: network as 'mainnet' | 'testnet',
  })

  const deploymentId = `gh-${deliveryId || crypto.randomUUID()}`

  await createDeployment(db, {
    id: deploymentId,
    userAddress,
    repoUrl,
    branch,
    baseDir,
    installCommand: installCommand || null,
    buildCommand: buildCommand || null,
    outputDir: outputDir || null,
    network: network as 'mainnet' | 'testnet',
    status: 'queued',
    error: null,
    objectId: null,
    base36Url: null,
    logs: '',
  })

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await updateDeployment(db, deploymentId, { status: 'building' })

        const container = getContainer(env.BUILD_CONTAINER, deploymentId)

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
          await updateDeployment(db, deploymentId, { status: 'failed', error: `container returned ${startResp.status}: ${text.slice(0, 500)}` })
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
        let lastLogLen = 0
        let pollCount = 0
        let distPath: string | undefined

        while (pollCount < 300) {
          pollCount++
          await new Promise((r) => setTimeout(r, 2000))
          if (pollCount % 3 === 0) {
            try {
              await touchDeployment(db, deploymentId)
            } catch { /* ignore */ }
          }
          try {
            const logResp = await timedContainerFetch(container, new Request(`http://localhost/logs/${buildId}`))
            if (logResp.ok) {
              const logData = await logResp.json() as { logs: string }
              if (logData.logs && logData.logs.length > lastLogLen) {
                await updateDeployment(db, deploymentId, { logs: logData.logs })
                lastLogLen = logData.logs.length
              }
            }
          } catch {}
          try {
            const statusResp = await timedContainerFetch(container, new Request(`http://localhost/status/${buildId}`))
            if (statusResp.ok) {
              const state = await statusResp.json() as { status: string; distPath?: string; error?: string }
              if (state.status === 'done' && state.distPath) { distPath = state.distPath; break }
              if (state.status === 'error') {
                const lr = await timedContainerFetch(container, new Request(`http://localhost/logs/${buildId}`))
                let logs = ''; if (lr.ok) { const d = await lr.json() as { logs: string }; logs = d.logs }
                await updateDeployment(db, deploymentId, { status: 'failed', error: state.error || 'build failed', logs })
                return
              }
            }
          } catch {}
        }

        if (!distPath) {
          await updateDeployment(db, deploymentId, { status: 'failed', error: 'build timed out' })
          return
        }

        await updateDeployment(db, deploymentId, { status: 'built' })

        await updateDeployment(db, deploymentId, { status: 'deploying' })

        // Ensure container is still running before deploy
        await container.startAndWaitForPorts({
          cancellationOptions: { portReadyTimeoutMS: 30000 },
        })

        const deployCmd: DeployCommand = {
          distPath,
          network: network as 'mainnet' | 'testnet',
          suiKeystore: (env.SUI_KEYSTORE as string) || '',
          suiAddress: (env.SUI_ADDRESS as string) || '',
          buildId: deploymentId,
        }

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
          const currentDeploy = await getDeployment(db, deploymentId)
          const deployLogs = Array.isArray(deployResult.logs) ? deployResult.logs.join('\n') : String(deployResult.logs || '')
          const combinedLogs = (currentDeploy?.logs || '') + '\n--- Deploy ---\n' + deployLogs
          await updateDeployment(db, deploymentId, {
            status: 'failed',
            error: deployResult.error || 'deploy failed',
            logs: combinedLogs,
          })
          return
        }

        const currentDeploy = await getDeployment(db, deploymentId)
        const deployLogs = Array.isArray(deployResult.logs) ? deployResult.logs.join('\n') : String(deployResult.logs || '')
        const combinedLogs = (currentDeploy?.logs || '') + '\n--- Deploy ---\n' + deployLogs
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
    })()
  )

  return c.json({ id: deploymentId, status: 'queued' }, 202)
})

export default router
