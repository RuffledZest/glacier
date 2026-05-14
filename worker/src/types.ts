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
  epochs?: number | 'max'
  siteName?: string
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
