import type { D1Database } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { Env } from './index'
import type { Deployment } from './types'

type Ctx = Context<{ Bindings: Env }>

export function getDb(c: Ctx): D1Database {
  return c.env.DB
}

export async function createDeployment(
  db: D1Database,
  deployment: Omit<Deployment, 'createdAt' | 'updatedAt'>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO deployments
       (id, user_address, repo_url, branch, base_dir, install_command, build_command, output_dir, network, status, logs)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
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
      deployment.status,
      deployment.logs
    )
    .run()
}

export async function updateDeployment(
  db: D1Database,
  id: string,
  updates: Partial<Pick<Deployment, 'status' | 'logs' | 'objectId' | 'base36Url' | 'error' | 'outputDir'>>
): Promise<void> {
  const sets: string[] = ['updated_at = datetime(\'now\')']
  const values: (string | null)[] = []

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

function mapRow(row: Record<string, unknown>): Deployment {
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
    status: row.status as Deployment['status'],
    error: row.error as string | null,
    objectId: row.object_id as string | null,
    base36Url: row.base36_url as string | null,
    logs: row.logs as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}
