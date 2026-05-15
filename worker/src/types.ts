export interface BuildConfig {
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun'
  installCommand: string
  buildCommand: string
  outputDir: string
  baseDir: string
  framework?: string
}

export interface DeployRequest {
  repoUrl: string
  branch?: string
  network?: 'mainnet' | 'testnet'
  baseDir?: string
  installCommand?: string
  buildCommand?: string
  outputDir?: string
  /** Mainnet: 2 | 7 | 13 | 26, or omit (→2) / `"max"` (→26 legacy). Testnet: 1–7 (≈ days). */
  epochs?: number | 'max'
  siteName?: string
  /** Optional env vars to import into the project before this deployment. Values are never returned by APIs. */
  env?: Record<string, string>
}

export interface Project {
  id: string
  userAddress: string
  repoUrl: string
  branch: string
  baseDir: string
  installCommand: string | null
  buildCommand: string | null
  outputDir: string | null
  network: 'mainnet' | 'testnet'
  createdAt: string
  updatedAt: string
}

export interface Deployment {
  id: string
  userAddress: string
  repoUrl: string
  branch: string
  baseDir: string
  installCommand: string | null
  buildCommand: string | null
  outputDir: string | null
  network: 'mainnet' | 'testnet'
  /** Walrus storage epochs for this deploy; null on rows before migration or legacy data */
  epochs: number | null
  status: 'queued' | 'building' | 'built' | 'deploying' | 'deployed' | 'failed' | 'deleted'
  error: string | null
  objectId: string | null
  base36Url: string | null
  logs: string
  createdAt: string
  updatedAt: string
}

export interface BuildRequest {
  repoUrl: string
  branch: string
  baseDir?: string
  installCommand?: string
  buildCommand?: string
  outputDir?: string
  githubToken?: string
  buildId?: string
  /** Project secrets decrypted by the worker and injected into install/build only. */
  env?: Record<string, string>
}

export interface ProjectSecretRecord {
  id: string
  projectId: string
  userAddress: string
  name: string
  ciphertext: string
  iv: string
  algorithm: 'AES-256-GCM'
  keyVersion: string
  createdAt: string
  updatedAt: string
}

export interface ProjectSecretMetadata {
  name: string
  createdAt: string
  updatedAt: string
}

export interface BuildResult {
  success: boolean
  distPath?: string
  error?: string
  logs: string[]
  detectedConfig?: BuildConfig
}

export interface DeployCommand {
  distPath: string
  network: 'mainnet' | 'testnet'
  epochs?: number | 'max'
  siteName?: string
  existingObjectId?: string
  suiKeystore: string
  suiAddress: string
  buildId?: string
}

export interface DeployResult {
  success: boolean
  objectId?: string
  base36Url?: string
  error?: string
  logs: string[]
}

export interface JwtPayload {
  sub: string
  address: string
  github_login?: string
  iat: number
  exp: number
}
