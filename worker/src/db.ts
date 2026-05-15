import type { D1Database } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { Env } from './index'
import type { Deployment, Project, ProjectSecretMetadata, ProjectSecretRecord } from './types'

type Ctx = Context<{ Bindings: Env }>

export function getDb(c: Ctx): D1Database {
  return c.env.DB
}

// ── Projects ──

export async function upsertProject(
  db: D1Database,
  project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM projects WHERE user_address = ?1 AND repo_url = ?2')
    .bind(project.userAddress, project.repoUrl)
    .first<{ id: string }>()

  if (existing) {
    await db
      .prepare(
        `UPDATE projects SET
         branch = ?1, base_dir = ?2, install_command = ?3, build_command = ?4,
         output_dir = ?5, network = ?6, updated_at = datetime('now')
         WHERE id = ?7`
      )
      .bind(
        project.branch,
        project.baseDir,
        project.installCommand ?? null,
        project.buildCommand ?? null,
        project.outputDir ?? null,
        project.network,
        existing.id
      )
      .run()
    return existing.id
  }

  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO projects
       (id, user_address, repo_url, branch, base_dir, install_command, build_command, output_dir, network)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      id,
      project.userAddress,
      project.repoUrl,
      project.branch,
      project.baseDir,
      project.installCommand ?? null,
      project.buildCommand ?? null,
      project.outputDir ?? null,
      project.network
    )
    .run()
  return id
}

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  const result = await db
    .prepare('SELECT * FROM projects WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>()

  if (!result) return null
  return mapProjectRow(result)
}

export async function getProjectByRepo(
  db: D1Database,
  userAddress: string,
  repoUrl: string
): Promise<Project | null> {
  const result = await db
    .prepare('SELECT * FROM projects WHERE user_address = ?1 AND repo_url = ?2')
    .bind(userAddress, repoUrl)
    .first<Record<string, unknown>>()

  if (!result) return null
  return mapProjectRow(result)
}

export async function getProjects(db: D1Database, userAddress: string): Promise<Project[]> {
  const result = await db
    .prepare('SELECT * FROM projects WHERE user_address = ?1 ORDER BY updated_at DESC')
    .bind(userAddress)
    .all<Record<string, unknown>>()

  return (result.results ?? []).map(mapProjectRow)
}

export async function deleteProject(db: D1Database, id: string, userAddress: string): Promise<void> {
  const project = await getProject(db, id)
  if (!project || project.userAddress !== userAddress) return

  // Mark all associated deployments as deleted
  await db
    .prepare("UPDATE deployments SET status = 'deleted', updated_at = datetime('now') WHERE repo_url = ?1 AND user_address = ?2")
    .bind(project.repoUrl, userAddress)
    .run()

  // Delete encrypted project secrets
  await db
    .prepare('DELETE FROM project_secrets WHERE project_id = ?1 AND user_address = ?2')
    .bind(id, userAddress)
    .run()

  // Delete the project
  await db
    .prepare('DELETE FROM projects WHERE id = ?1')
    .bind(id)
    .run()
}

function mapProjectRow(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    userAddress: row.user_address as string,
    repoUrl: row.repo_url as string,
    branch: row.branch as string,
    baseDir: row.base_dir as string,
    installCommand: row.install_command as string | null,
    buildCommand: row.build_command as string | null,
    outputDir: row.output_dir as string | null,
    network: row.network as 'mainnet' | 'testnet',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

// ── Project Secrets ──

export async function listProjectSecrets(
  db: D1Database,
  projectId: string,
  userAddress: string
): Promise<ProjectSecretMetadata[]> {
  const result = await db
    .prepare(
      `SELECT name, created_at, updated_at
       FROM project_secrets
       WHERE project_id = ?1 AND user_address = ?2
       ORDER BY name ASC`
    )
    .bind(projectId, userAddress)
    .all<Record<string, unknown>>()

  return (result.results ?? []).map((row) => ({
    name: row.name as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }))
}

export async function getProjectSecretRecords(
  db: D1Database,
  projectId: string,
  userAddress: string
): Promise<ProjectSecretRecord[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM project_secrets
       WHERE project_id = ?1 AND user_address = ?2
       ORDER BY name ASC`
    )
    .bind(projectId, userAddress)
    .all<Record<string, unknown>>()

  return (result.results ?? []).map(mapProjectSecretRow)
}

export async function upsertProjectSecret(
  db: D1Database,
  record: Omit<ProjectSecretRecord, 'createdAt' | 'updatedAt'>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_secrets
       (id, project_id, user_address, name, ciphertext, iv, algorithm, key_version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(project_id, name) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         algorithm = excluded.algorithm,
         key_version = excluded.key_version,
         updated_at = datetime('now')`
    )
    .bind(
      record.id,
      record.projectId,
      record.userAddress,
      record.name,
      record.ciphertext,
      record.iv,
      record.algorithm,
      record.keyVersion,
    )
    .run()
}

export async function deleteProjectSecret(
  db: D1Database,
  projectId: string,
  userAddress: string,
  name: string
): Promise<void> {
  await db
    .prepare('DELETE FROM project_secrets WHERE project_id = ?1 AND user_address = ?2 AND name = ?3')
    .bind(projectId, userAddress, name)
    .run()
}

function mapProjectSecretRow(row: Record<string, unknown>): ProjectSecretRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    userAddress: row.user_address as string,
    name: row.name as string,
    ciphertext: row.ciphertext as string,
    iv: row.iv as string,
    algorithm: row.algorithm as 'AES-256-GCM',
    keyVersion: row.key_version as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

// ── Deployments ──

export async function createDeployment(
  db: D1Database,
  deployment: Omit<Deployment, 'createdAt' | 'updatedAt'>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO deployments
       (id, user_address, repo_url, branch, base_dir, install_command, build_command, output_dir, network, epochs, status, logs)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    )
    .bind(
      deployment.id,
      deployment.userAddress,
      deployment.repoUrl,
      deployment.branch,
      deployment.baseDir,
      deployment.installCommand ?? null,
      deployment.buildCommand ?? null,
      deployment.outputDir ?? null,
      deployment.network,
      deployment.epochs ?? null,
      deployment.status,
      deployment.logs
    )
    .run()
}

/** Touch `updated_at` only (heartbeat while build/deploy is still running). */
export async function touchDeployment(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE deployments SET updated_at = datetime('now') WHERE id = ?1`)
    .bind(id)
    .run()
}

export async function updateDeployment(
  db: D1Database,
  id: string,
  updates: Partial<Pick<Deployment, 'status' | 'logs' | 'objectId' | 'base36Url' | 'error' | 'outputDir' | 'epochs'>>
): Promise<void> {
  const sets: string[] = ['updated_at = datetime(\'now\')']
  const values: (string | number | null)[] = []

  if (updates.status !== undefined) {
    sets.push('status = ?')
    values.push(updates.status)
  }
  if (updates.logs !== undefined) {
    sets.push('logs = ?')
    values.push(updates.logs)
  }
  if (updates.objectId !== undefined) {
    sets.push('object_id = ?')
    values.push(updates.objectId)
  }
  if (updates.base36Url !== undefined) {
    sets.push('base36_url = ?')
    values.push(updates.base36Url)
  }
  if (updates.error !== undefined) {
    sets.push('error = ?')
    values.push(updates.error)
  }
  if (updates.outputDir !== undefined) {
    sets.push('output_dir = ?')
    values.push(updates.outputDir)
  }
  if (updates.epochs !== undefined) {
    sets.push('epochs = ?')
    values.push(updates.epochs)
  }

  values.push(id)
  await db
    .prepare(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?${values.length}`)
    .bind(...values)
    .run()
}

export async function getDeployment(db: D1Database, id: string): Promise<Deployment | null> {
  const result = await db
    .prepare('SELECT * FROM deployments WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>()

  if (!result) return null
  return mapRow(result)
}

export async function getDeployments(
  db: D1Database,
  userAddress: string,
  limit = 20,
  offset = 0
): Promise<Deployment[]> {
  const result = await db
    .prepare(
      'SELECT * FROM deployments WHERE user_address = ?1 AND status != \'deleted\' ORDER BY created_at DESC LIMIT ?2 OFFSET ?3'
    )
    .bind(userAddress, limit, offset)
    .all<Record<string, unknown>>()

  return (result.results ?? []).map(mapRow)
}

export async function getDeploymentsByRepo(
  db: D1Database,
  userAddress: string,
  repoUrl: string
): Promise<Deployment[]> {
  const result = await db
    .prepare(
      'SELECT * FROM deployments WHERE user_address = ?1 AND repo_url = ?2 AND status != \'deleted\' ORDER BY created_at DESC'
    )
    .bind(userAddress, repoUrl)
    .all<Record<string, unknown>>()

  return (result.results ?? []).map(mapRow)
}

function mapRow(row: Record<string, unknown>): Deployment {
  const epochsRaw = row.epochs
  const epochs =
    typeof epochsRaw === 'number' && Number.isFinite(epochsRaw)
      ? epochsRaw
      : typeof epochsRaw === 'string' && epochsRaw !== '' && Number.isFinite(Number(epochsRaw))
        ? Number(epochsRaw)
        : null

  return {
    id: row.id as string,
    userAddress: row.user_address as string,
    repoUrl: row.repo_url as string,
    branch: row.branch as string,
    baseDir: row.base_dir as string,
    installCommand: row.install_command as string | null,
    buildCommand: row.build_command as string | null,
    outputDir: row.output_dir as string | null,
    network: row.network as 'mainnet' | 'testnet',
    epochs,
    status: row.status as Deployment['status'],
    error: row.error as string | null,
    objectId: row.object_id as string | null,
    base36Url: row.base36_url as string | null,
    logs: row.logs as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}
