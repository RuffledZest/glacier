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
  listProjectSecrets,
  getProjectSecretRecords,
  upsertProjectSecret,
  deleteProjectSecret,
} from '../db'
import type { DeployRequest, BuildRequest, DeployCommand } from '../types'
import type { Deployment, DeployResult } from '../types'
import { detectFromGithubApi } from '../auto-detect'
import { resolveMainnetEpochs, resolveTestnetEpochs } from '../epochs'
import { coerceRelativeOutputDir } from '../output-dir'
import { getCommit, isCommitReachableFromRef, type GithubCommit } from '../github-api'
import {
  MAX_PROJECT_SECRETS,
  decryptProjectSecret,
  encryptProjectSecret,
  normalizeSecretMap,
  parseEnvFile,
  validateSecretName,
  validateSecretValue,
} from '../secrets'

const router = new Hono<{ Bindings: Env }>()

type ContainerDeployState = {
  status?: 'pending' | 'running' | 'done' | 'error'
  phase?: 'build' | 'deploy'
  error?: string
  deployResult?: Omit<DeployResult, 'logs'>
}

type DeploymentCommitFields = Pick<
  Deployment,
  'commitSha' | 'commitRef' | 'commitMessage' | 'commitAuthorName' | 'commitAuthorDate' | 'commitUrl'
>

const ACTIVE_DEPLOYMENT_STATUSES = new Set(['queued', 'building', 'built', 'deploying'])

function parseGithubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(repoUrl.replace(/\.git$/, ''))
    if (url.hostname !== 'github.com') return null
    const [owner, repo] = url.pathname.replace(/^\/+/, '').split('/')
    if (!owner || !repo) return null
    return { owner, repo }
  } catch {
    return null
  }
}

function mapGithubCommit(commit: GithubCommit, commitRef: string): DeploymentCommitFields {
  return {
    commitSha: commit.sha,
    commitRef,
    commitMessage: commit.message || null,
    commitAuthorName: commit.authorName,
    commitAuthorDate: commit.authorDate,
    commitUrl: commit.htmlUrl,
  }
}

async function getGithubTokenForUser(db: D1Database, userAddress: string, env: Env): Promise<string | null> {
  const row = await db
    .prepare('SELECT access_token FROM github_tokens WHERE user_address = ?1')
    .bind(userAddress)
    .first<{ access_token: string }>()
  return row?.access_token || env.GITHUB_TOKEN || null
}

async function resolveDeploymentCommit(
  env: Env,
  db: D1Database,
  userAddress: string,
  repoUrl: string,
  branch: string,
  requestedSha?: string | null,
): Promise<{ ok: true; commit: DeploymentCommitFields } | { ok: false; error: string; status?: 400 | 401 | 500 }> {
  const parsed = parseGithubRepoUrl(repoUrl)
  if (!parsed) return { ok: false, error: 'invalid GitHub repository URL', status: 400 }

  const token = await getGithubTokenForUser(db, userAddress, env)
  if (!token) return { ok: false, error: 'GitHub not connected', status: 401 }

  const ref = requestedSha?.trim() || branch
  if (requestedSha && !/^[0-9a-f]{7,40}$/i.test(requestedSha.trim())) {
    return { ok: false, error: 'commitSha must be a Git commit SHA', status: 400 }
  }

  const commit = await getCommit(token, parsed.owner, parsed.repo, ref)
  if (!commit) {
    return { ok: false, error: requestedSha ? 'commit not found' : 'branch head commit not found', status: 400 }
  }

  if (requestedSha) {
    const reachable = await isCommitReachableFromRef(token, parsed.owner, parsed.repo, commit.sha, branch)
    if (!reachable) {
      return { ok: false, error: `commit is not reachable from branch ${branch}`, status: 400 }
    }
  }

  return { ok: true, commit: mapGithubCommit(commit, requestedSha?.trim() || branch) }
}

function preferLatestLogs(currentLogs: string, containerLogs: string): string {
  if (!containerLogs) return currentLogs
  if (!currentLogs) return containerLogs
  return containerLogs.length >= currentLogs.length ? containerLogs : currentLogs
}

async function upsertProjectSecretsFromMap(
  env: Env,
  db: D1Database,
  projectId: string,
  userAddress: string,
  input: unknown,
): Promise<void> {
  const secrets = normalizeSecretMap(input)
  const entries = Object.entries(secrets)
  if (entries.length === 0) return

  const existing = await listProjectSecrets(db, projectId, userAddress)
  const uniqueNames = new Set([...existing.map((s) => s.name), ...entries.map(([name]) => name)])
  if (uniqueNames.size > MAX_PROJECT_SECRETS) {
    throw new Error(`A project can store at most ${MAX_PROJECT_SECRETS} secrets`)
  }

  for (const [name, value] of entries) {
    const encrypted = await encryptProjectSecret(env, { userAddress, projectId, name, value })
    await upsertProjectSecret(db, {
      id: crypto.randomUUID(),
      projectId,
      userAddress,
      name,
      ...encrypted,
    })
  }
}

async function loadProjectBuildEnv(
  env: Env,
  db: D1Database,
  projectId: string | undefined,
  userAddress: string,
  transientInput?: unknown,
): Promise<Record<string, string>> {
  const buildEnv: Record<string, string> = {}

  if (projectId) {
    const records = await getProjectSecretRecords(db, projectId, userAddress)
    for (const record of records) {
      buildEnv[record.name] = await decryptProjectSecret(env, record)
    }
  }

  const transient = normalizeSecretMap(transientInput)
  const uniqueNames = new Set([...Object.keys(buildEnv), ...Object.keys(transient)])
  if (uniqueNames.size > MAX_PROJECT_SECRETS) {
    throw new Error(`A build can use at most ${MAX_PROJECT_SECRETS} secrets`)
  }

  return { ...buildEnv, ...transient }
}

async function finalizeDeploymentFromContainer(
  env: Env,
  db: D1Database,
  deployment: Deployment,
): Promise<Deployment> {
  if (deployment.status !== 'deploying') return deployment

  try {
    const container = getContainer(env.BUILD_CONTAINER, deployment.id)
    await container.startAndWaitForPorts({ cancellationOptions: { portReadyTimeoutMS: 10000 } })

    const statusResp = await timedContainerFetch(container, new Request(`http://localhost/status/${deployment.id}`), 10000)
    if (!statusResp.ok) return deployment

    const state = await statusResp.json() as ContainerDeployState
    if (state.phase !== 'deploy') return deployment

    const logResp = await timedContainerFetch(container, new Request(`http://localhost/logs/${deployment.id}`), 10000)
    let logs = deployment.logs
    if (logResp.ok) {
      const logData = await logResp.json() as { logs?: string }
      logs = preferLatestLogs(deployment.logs, logData.logs || '')
    }

    if (state.deployResult?.success) {
      await updateDeployment(db, deployment.id, {
        status: 'deployed',
        objectId: state.deployResult.objectId || null,
        base36Url: state.deployResult.base36Url || null,
        logs,
        epochs: deployment.epochs ?? null,
      })
    } else if (state.status === 'error' || state.deployResult) {
      await updateDeployment(db, deployment.id, {
        status: 'failed',
        error: state.deployResult?.error || state.error || 'deploy failed',
        logs,
      })
    } else {
      return deployment
    }

    return (await getDeployment(db, deployment.id)) || deployment
  } catch {
    return deployment
  }
}

async function findExistingSiteObjectId(
  db: D1Database,
  deploymentId: string,
  repoUrl: string,
  network: 'mainnet' | 'testnet',
  baseDir: string,
): Promise<string | undefined> {
  const current = await getDeployment(db, deploymentId)
  if (!current) return undefined

  const deployments = await getDeploymentsByRepo(db, current.userAddress, repoUrl)
  const existing = deployments.find((d) =>
    d.id !== deploymentId &&
    d.status === 'deployed' &&
    d.network === network &&
    d.baseDir === baseDir &&
    !!d.objectId
  )

  return existing?.objectId || undefined
}

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
  const requestedCommitSha = body.commitSha?.trim() || undefined

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

  if (!requestedCommitSha && (!installCommand || !buildCommand || !outputDir)) {
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

  const userAddress = payload.address as string
  const resolvedCommit = await resolveDeploymentCommit(c.env, db, userAddress, repoUrl, branch, requestedCommitSha)
  if (!resolvedCommit.ok) {
    return c.json({ error: resolvedCommit.error }, resolvedCommit.status || 500)
  }

  // Upsert project with build config
  const projectId = await upsertProject(db, {
    userAddress,
    repoUrl,
    branch,
    baseDir,
    installCommand: installCommand || null,
    buildCommand: buildCommand || null,
    outputDir: normalizedOutputDir,
    network,
  })

  try {
    await upsertProjectSecretsFromMap(c.env, db, projectId, userAddress, body.env)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'invalid project secrets' }, 400)
  }

  const deploymentId = crypto.randomUUID()

  await createDeployment(db, {
    id: deploymentId,
    userAddress,
    repoUrl,
    branch,
    ...resolvedCommit.commit,
    baseDir,
    installCommand: installCommand || null,
    buildCommand: buildCommand || null,
    outputDir: normalizedOutputDir,
    network,
    epochs,
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
      userAddress,
      projectId,
      repoUrl,
      branch,
      resolvedCommit.commit.commitSha || undefined,
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
  let deployment = await getDeployment(db, id)

  if (!deployment) {
    return c.json({ error: 'deployment not found' }, 404)
  }

  if (deployment.userAddress !== (payload.address as string)) {
    return c.json({ error: 'not authorized' }, 403)
  }

  deployment = await finalizeDeploymentFromContainer(c.env, db, deployment)

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

  // Use the original deployment config for reproducible retry semantics.
  const project = await getProjectByRepo(db, payload.address as string, deployment.repoUrl)

  const retryId = crypto.randomUUID()

  const retryBase = deployment.baseDir || '.'
  const safeOutputDir =
    coerceRelativeOutputDir(deployment.outputDir, retryBase) ??
    coerceRelativeOutputDir(deployment.outputDir, deployment.baseDir || '.') ??
    'dist'

  const retryEpochs =
    deployment.epochs ??
    (deployment.network === 'mainnet' ? 2 : resolveTestnetEpochs(undefined))
  const commit =
    deployment.commitSha
      ? {
          commitSha: deployment.commitSha,
          commitRef: deployment.commitRef,
          commitMessage: deployment.commitMessage,
          commitAuthorName: deployment.commitAuthorName,
          commitAuthorDate: deployment.commitAuthorDate,
          commitUrl: deployment.commitUrl,
        }
      : await resolveDeploymentCommit(
          c.env,
          db,
          payload.address as string,
          deployment.repoUrl,
          deployment.branch,
          undefined,
        )

  if ('ok' in commit && !commit.ok) {
    return c.json({ error: commit.error }, commit.status || 500)
  }

  const commitFields = 'ok' in commit ? commit.commit : commit

  await createDeployment(db, {
    id: retryId,
    userAddress: payload.address as string,
    repoUrl: deployment.repoUrl,
    branch: deployment.branch,
    ...commitFields,
    baseDir: deployment.baseDir,
    installCommand: deployment.installCommand,
    buildCommand: deployment.buildCommand,
    outputDir: safeOutputDir,
    network: deployment.network,
    epochs: retryEpochs,
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
      payload.address as string,
      project?.id,
      deployment.repoUrl,
      deployment.branch,
      commitFields.commitSha || undefined,
      deployment.baseDir || '.',
      deployment.installCommand || undefined,
      deployment.buildCommand || undefined,
      safeOutputDir,
      deployment.network,
      retryEpochs,
      undefined
    )
  )

  return c.json({ id: retryId, status: 'queued' }, 202)
})

router.post('/deployments/:id/redeploy', async (c) => {
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

  const userAddress = payload.address as string
  if (deployment.userAddress !== userAddress) {
    return c.json({ error: 'not authorized' }, 403)
  }

  if (ACTIVE_DEPLOYMENT_STATUSES.has(deployment.status)) {
    return c.json({ error: 'active deployments cannot be redeployed' }, 400)
  }

  if (deployment.status === 'deleted') {
    return c.json({ error: 'deleted deployments cannot be redeployed' }, 400)
  }

  const project = await getProjectByRepo(db, userAddress, deployment.repoUrl)
  const redeployId = crypto.randomUUID()
  const redeployBase = deployment.baseDir || '.'
  const safeOutputDir = coerceRelativeOutputDir(deployment.outputDir, redeployBase) ?? deployment.outputDir ?? 'dist'
  const redeployEpochs =
    deployment.epochs ??
    (deployment.network === 'mainnet' ? 2 : resolveTestnetEpochs(undefined))
  const commit =
    deployment.commitSha
      ? {
          commitSha: deployment.commitSha,
          commitRef: deployment.commitRef,
          commitMessage: deployment.commitMessage,
          commitAuthorName: deployment.commitAuthorName,
          commitAuthorDate: deployment.commitAuthorDate,
          commitUrl: deployment.commitUrl,
        }
      : await resolveDeploymentCommit(c.env, db, userAddress, deployment.repoUrl, deployment.branch, undefined)

  if ('ok' in commit && !commit.ok) {
    return c.json({ error: commit.error }, commit.status || 500)
  }

  const commitFields = 'ok' in commit ? commit.commit : commit

  await createDeployment(db, {
    id: redeployId,
    userAddress,
    repoUrl: deployment.repoUrl,
    branch: deployment.branch,
    ...commitFields,
    baseDir: deployment.baseDir,
    installCommand: deployment.installCommand,
    buildCommand: deployment.buildCommand,
    outputDir: safeOutputDir,
    network: deployment.network,
    epochs: redeployEpochs,
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
      redeployId,
      userAddress,
      project?.id,
      deployment.repoUrl,
      deployment.branch,
      commitFields.commitSha || undefined,
      deployment.baseDir || '.',
      deployment.installCommand || undefined,
      deployment.buildCommand || undefined,
      safeOutputDir,
      deployment.network,
      redeployEpochs,
      undefined
    )
  )

  return c.json({ id: redeployId, status: 'queued' }, 202)
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
  let deployment = await getDeployment(db, id)
  if (!deployment || deployment.userAddress !== (payload.address as string)) {
    return c.json({ error: 'not found' }, 404)
  }

  deployment = await finalizeDeploymentFromContainer(c.env, db, deployment)

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

router.post('/projects/:id/deploy-latest', async (c) => {
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

  const userAddress = payload.address as string
  const project = await getProject(db, c.req.param('id'))
  if (!project || project.userAddress !== userAddress) {
    return c.json({ error: 'project not found' }, 404)
  }

  const resolvedCommit = await resolveDeploymentCommit(
    c.env,
    db,
    userAddress,
    project.repoUrl,
    project.branch,
    undefined,
  )
  if (!resolvedCommit.ok) {
    return c.json({ error: resolvedCommit.error }, resolvedCommit.status || 500)
  }

  const deploymentId = crypto.randomUUID()
  const baseDir = project.baseDir || '.'
  const outputDir = coerceRelativeOutputDir(project.outputDir, baseDir) ?? project.outputDir ?? 'dist'
  const epochs = project.network === 'mainnet' ? 2 : resolveTestnetEpochs(undefined)

  await createDeployment(db, {
    id: deploymentId,
    userAddress,
    repoUrl: project.repoUrl,
    branch: project.branch,
    ...resolvedCommit.commit,
    baseDir: project.baseDir,
    installCommand: project.installCommand,
    buildCommand: project.buildCommand,
    outputDir,
    network: project.network,
    epochs,
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
      userAddress,
      project.id,
      project.repoUrl,
      project.branch,
      resolvedCommit.commit.commitSha || undefined,
      project.baseDir || '.',
      project.installCommand || undefined,
      project.buildCommand || undefined,
      outputDir,
      project.network,
      epochs,
      undefined
    )
  )

  return c.json({ id: deploymentId, status: 'queued' }, 202)
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

router.get('/projects/:id/secrets', async (c) => {
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
  const userAddress = payload.address as string

  if (!project || project.userAddress !== userAddress) {
    return c.json({ error: 'project not found' }, 404)
  }

  const secrets = await listProjectSecrets(db, id, userAddress)
  return c.json({ secrets })
})

router.put('/projects/:id/secrets/:name', async (c) => {
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
  const name = c.req.param('name')
  const userAddress = payload.address as string
  const project = await getProject(db, id)

  if (!project || project.userAddress !== userAddress) {
    return c.json({ error: 'project not found' }, 404)
  }

  const nameError = validateSecretName(name)
  if (nameError) return c.json({ error: nameError }, 400)

  const body = await c.req.json<{ value?: unknown }>()
  if (typeof body.value !== 'string') return c.json({ error: 'value is required' }, 400)

  const valueError = validateSecretValue(body.value)
  if (valueError) return c.json({ error: valueError }, 400)

  try {
    await upsertProjectSecretsFromMap(c.env, db, id, userAddress, { [name]: body.value })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'secret update failed' }, 400)
  }

  const secrets = await listProjectSecrets(db, id, userAddress)
  return c.json({ secrets })
})

router.post('/projects/:id/secrets/import', async (c) => {
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
  const userAddress = payload.address as string
  const project = await getProject(db, id)

  if (!project || project.userAddress !== userAddress) {
    return c.json({ error: 'project not found' }, 404)
  }

  const body = await c.req.json<{ content?: unknown; secrets?: unknown }>()

  try {
    const fromContent = typeof body.content === 'string' ? parseEnvFile(body.content) : {}
    const fromMap = body.secrets ? normalizeSecretMap(body.secrets) : {}
    await upsertProjectSecretsFromMap(c.env, db, id, userAddress, { ...fromContent, ...fromMap })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'secret import failed' }, 400)
  }

  const secrets = await listProjectSecrets(db, id, userAddress)
  return c.json({ secrets })
})

router.delete('/projects/:id/secrets/:name', async (c) => {
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
  const name = c.req.param('name')
  const userAddress = payload.address as string
  const project = await getProject(db, id)

  if (!project || project.userAddress !== userAddress) {
    return c.json({ error: 'project not found' }, 404)
  }

  const nameError = validateSecretName(name)
  if (nameError) return c.json({ error: nameError }, 400)

  await deleteProjectSecret(db, id, userAddress, name)
  const secrets = await listProjectSecrets(db, id, userAddress)
  return c.json({ secrets })
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
  userAddress: string,
  projectId: string | undefined,
  repoUrl: string,
  branch: string,
  commitSha: string | undefined,
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
    const projectEnv = await loadProjectBuildEnv(env, db, projectId, userAddress)
    const githubToken = await getGithubTokenForUser(db, userAddress, env)

    const container = getContainer(env.BUILD_CONTAINER, deploymentId)

    // Ensure container is started before sending requests
    await container.startAndWaitForPorts({
      cancellationOptions: { portReadyTimeoutMS: 30000 },
    })

    // Phase 1: Start async build
    const buildReq: BuildRequest = {
      repoUrl,
      branch,
      commitSha,
      baseDir,
      installCommand,
      buildCommand,
      outputDir: effectiveOutputDir,
      githubToken: githubToken || undefined,
      buildId: deploymentId,
      env: projectEnv,
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
    const existingObjectId = await findExistingSiteObjectId(db, deploymentId, repoUrl, network, baseDir)

    // Ensure container is still running before deploy (it may have shut down after build)
    await container.startAndWaitForPorts({
      cancellationOptions: { portReadyTimeoutMS: 30000 },
    })

    const deployCmd: DeployCommand = {
      distPath,
      network,
      epochs,
      siteName,
      existingObjectId,
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
      const combinedLogs = preferLatestLogs(current?.logs || '', deployLogs)
      await updateDeployment(db, deploymentId, {
        status: 'failed',
        error: deployResult.error || 'deploy failed',
        logs: combinedLogs,
      })
      return
    }

    const current = await getDeployment(db, deploymentId)
    const deployLogs = Array.isArray(deployResult.logs) ? deployResult.logs.join('\n') : String(deployResult.logs || '')
    const combinedLogs = preferLatestLogs(current?.logs || '', deployLogs)
    await updateDeployment(db, deploymentId, {
      status: 'deployed',
      objectId: deployResult.objectId || null,
      base36Url: deployResult.base36Url || null,
      logs: combinedLogs,
      epochs,
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
