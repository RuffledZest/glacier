import type { Env } from './index'
import type { ProjectSecretRecord } from './types'

export const MAX_PROJECT_SECRETS = 64
export const MAX_SECRET_VALUE_BYTES = 8 * 1024
export const MAX_ENV_IMPORT_BYTES = 64 * 1024

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_NAMES = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'PWD',
  'OLDPWD',
  'NODE_ENV',
  'CI',
  'PORT',
  'HOST',
  'GITHUB_TOKEN',
  'SUI_KEYSTORE',
  'SUI_ADDRESS',
  'SECRETS_ENCRYPTION_KEY',
  'JWT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'WEBHOOK_SECRET',
  'WALRUS_NETWORK',
  'WALRUS_EPOCHS',
  'WALRUS_GAS_BUDGET_MIST',
])
const RESERVED_PREFIXES = ['SUI_', 'CF_', 'CLOUDFLARE_', 'WRANGLER_', 'GLACIER_']

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function validateSecretName(name: string): string | null {
  if (!SECRET_NAME_RE.test(name)) return 'Secret names must match /^[A-Za-z_][A-Za-z0-9_]*$/'
  if (name.length > 128) return 'Secret names must be 128 characters or fewer'

  const upper = name.toUpperCase()
  if (RESERVED_NAMES.has(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return `${name} is reserved and cannot be configured as a project secret`
  }

  return null
}

export function validateSecretValue(value: string): string | null {
  const bytes = textEncoder.encode(value).byteLength
  if (bytes > MAX_SECRET_VALUE_BYTES) return `Secret values must be ${MAX_SECRET_VALUE_BYTES} bytes or smaller`
  return null
}

export function normalizeSecretMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}

  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim()
    const nameError = validateSecretName(name)
    if (nameError) throw new Error(nameError)
    if (typeof rawValue !== 'string') throw new Error(`${name} must be a string value`)

    const valueError = validateSecretValue(rawValue)
    if (valueError) throw new Error(`${name}: ${valueError}`)
    result[name] = rawValue
  }
  return result
}

export function parseEnvFile(content: string): Record<string, string> {
  if (textEncoder.encode(content).byteLength > MAX_ENV_IMPORT_BYTES) {
    throw new Error(`Env file must be ${MAX_ENV_IMPORT_BYTES} bytes or smaller`)
  }

  const result: Record<string, string> = {}
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i]
    const line = original.trim()
    if (!line || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trimStart() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) throw new Error(`Invalid env line ${i + 1}`)

    const name = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    const nameError = validateSecretName(name)
    if (nameError) throw new Error(`Line ${i + 1}: ${nameError}`)

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
      if (original.includes('"')) {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      }
    }

    const valueError = validateSecretValue(value)
    if (valueError) throw new Error(`Line ${i + 1}: ${valueError}`)
    result[name] = value
  }

  return result
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function readKeyBytes(env: Env): Uint8Array {
  const configured = env.SECRETS_ENCRYPTION_KEY?.trim()
  if (!configured) {
    throw new Error('SECRETS_ENCRYPTION_KEY is required for project secrets')
  }

  const raw = configured.startsWith('base64:') ? configured.slice(7) : configured
  try {
    const decoded = base64ToBytes(raw)
    if (decoded.byteLength === 32) return decoded
  } catch {
    // Fall through to raw UTF-8 support for local development.
  }

  const utf8 = textEncoder.encode(configured)
  if (utf8.byteLength === 32) return utf8
  throw new Error('SECRETS_ENCRYPTION_KEY must be 32 raw bytes or base64-encoded 32 bytes')
}

async function importAesKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    readKeyBytes(env),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

function additionalData(userAddress: string, projectId: string, name: string, keyVersion: string): Uint8Array {
  return textEncoder.encode(`${userAddress}\0${projectId}\0${name}\0${keyVersion}`)
}

export async function encryptProjectSecret(
  env: Env,
  input: { userAddress: string; projectId: string; name: string; value: string },
): Promise<Pick<ProjectSecretRecord, 'ciphertext' | 'iv' | 'algorithm' | 'keyVersion'>> {
  const keyVersion = 'v1'
  const key = await importAesKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(input.userAddress, input.projectId, input.name, keyVersion) },
    key,
    textEncoder.encode(input.value),
  )

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    algorithm: 'AES-256-GCM',
    keyVersion,
  }
}

export async function decryptProjectSecret(env: Env, record: ProjectSecretRecord): Promise<string> {
  if (record.algorithm !== 'AES-256-GCM') throw new Error(`Unsupported secret algorithm: ${record.algorithm}`)
  const key = await importAesKey(env)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(record.iv),
      additionalData: additionalData(record.userAddress, record.projectId, record.name, record.keyVersion),
    },
    key,
    base64ToBytes(record.ciphertext),
  )
  return textDecoder.decode(plaintext)
}
