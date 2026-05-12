import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface DeployParams {
  distPath: string
  network: 'mainnet' | 'testnet'
  epochs?: number | 'max'
  siteName?: string
  suiKeystore: string
  suiAddress: string
  logPath?: string
}

export interface DeployResult {
  success: boolean
  objectId?: string
  base36Url?: string
  error?: string
  logs: string[]
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

function totalDirSize(dir: string): number {
  let size = 0
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      size += totalDirSize(fullPath)
    } else if (entry.isFile()) {
      size += statSync(fullPath).size
    }
  }
  return size
}

function setupWallet(network: 'mainnet' | 'testnet', keystoreContent: string, suiAddress: string, logs: string[]) {
  const suiDir = join(homedir(), '.sui', 'sui_config')
  mkdirSync(suiDir, { recursive: true })

  const keystorePath = join(suiDir, 'sui.keystore')
  writeFileSync(keystorePath, keystoreContent, { mode: 0o600 })

  const rpc = network === 'testnet'
    ? 'https://fullnode.testnet.sui.io:443'
    : 'https://fullnode.mainnet.sui.io:443'

  const clientYaml = [
    '---',
    'keystore:',
    `  File: ${keystorePath}`,
    'envs:',
    `  - alias: ${network}`,
    `    rpc: "${rpc}"`,
    '    ws: ~',
    `active_env: ${network}`,
    `active_address: "${suiAddress}"`,
    '',
  ].join('\n')

  writeFileSync(join(suiDir, 'client.yaml'), clientYaml, { mode: 0o600 })
  logs.push('Sui wallet configured')
}

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
  }
  const data = await resp.json() as any
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error))
  }
  return data.result as T
}

async function getBalances(address: string, rpcUrl: string, logs: string[]): Promise<{ sui: bigint; wal: bigint }> {
  const suiResult = await rpcCall<{ totalBalance: string }>(rpcUrl, 'suix_getBalance', [address, '0x2::sui::SUI'])
  const sui = BigInt(suiResult.totalBalance)

  let wal = 0n
  try {
    const allBalances = await rpcCall<Array<{ coinType: string; totalBalance: string }>>(rpcUrl, 'suix_getAllBalances', [address])
    const walEntry = allBalances.find(b =>
      b.coinType.toLowerCase().includes('wal') ||
      b.coinType.toLowerCase().includes('frost')
    )
    if (walEntry) wal = BigInt(walEntry.totalBalance)
  } catch (err) {
    logs.push(`Note: getAllBalances failed (wallet may be empty): ${err instanceof Error ? err.message : 'unknown'}`)
  }

  return { sui, wal }
}

async function estimateCost(
  network: 'mainnet' | 'testnet',
  totalBytes: number,
  epochs: number | 'max',
  walrusBin: string,
  env: Record<string, string>,
  logs: string[]
): Promise<{ success: boolean; walNeeded: bigint; error?: string }> {
  try {
    const result = spawnSync(walrusBin, ['info', 'price', '--context', network], { env, encoding: 'utf-8', timeout: 30000 })
    const output = (result.stdout || '') + '\n' + (result.stderr || '')

    let pricePerMibPerEpoch = 0n
    const patterns = [
      /(\d+(?:\.\d+)?)\s*(?:FROST|WAL)\s+per\s+(?:MiB|MB)/i,
      /storage\s+price[:\s]+(\d+(?:\.\d+)?)/i,
      /price[:\s]+(\d+(?:\.\d+)?)/i,
      /(\d+(?:\.\d+)?)\s+per\s+epoch/i,
    ]

    for (const pattern of patterns) {
      const match = output.match(pattern)
      if (match) {
        const price = parseFloat(match[1])
        pricePerMibPerEpoch = BigInt(Math.ceil(price * 1_000_000_000))
        logs.push(`Parsed storage price: ${price} WAL per MiB per epoch`)
        break
      }
    }

    if (pricePerMibPerEpoch === 0n) {
      logs.push(`Could not parse price from walrus output; using fallback.`)
      logs.push(`Price output: ${output.slice(0, 800)}`)
      pricePerMibPerEpoch = 10_000_000n // 0.01 WAL/MiB/epoch fallback
    }

    const sizeMib = BigInt(Math.ceil(totalBytes / (1024 * 1024)))
    const effectiveSizeMib = sizeMib === 0n ? 1n : sizeMib

    let epochCount: bigint
    if (epochs === 'max') {
      epochCount = 53n
      logs.push('Using max epochs: 53')
    } else {
      epochCount = BigInt(epochs)
    }

    const walNeeded = effectiveSizeMib * pricePerMibPerEpoch * epochCount
    logs.push(`Cost: ${effectiveSizeMib} MiB × ${pricePerMibPerEpoch} FROST/MiB/epoch × ${epochCount} epochs = ${walNeeded} FROST`)

    return { success: true, walNeeded }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    logs.push(`Cost estimation failed: ${msg}`)
    return { success: true, walNeeded: 5_000_000_000n } // 5 WAL fallback
  }
}

async function exchangeSuiForWal(
  amountMist: bigint,
  walrusBin: string,
  network: 'mainnet' | 'testnet',
  env: Record<string, string>,
  logs: string[]
): Promise<{ success: boolean; error?: string }> {
  logs.push(`Exchanging ${amountMist} MIST SUI for WAL via walrus get-wal...`)

  const result = spawnSync(walrusBin, ['get-wal', '--context', network, '--amount', amountMist.toString()], {
    env,
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  })

  const stdout = result.stdout?.trim() || ''
  const stderr = result.stderr?.trim() || ''

  if (stdout) logs.push(`get-wal output: ${stdout.slice(0, 2000)}`)
  if (stderr) logs.push(`get-wal stderr: ${stderr.slice(0, 2000)}`)

  if (result.status !== 0) {
    return { success: false, error: `get-wal exited with code ${result.status}: ${stderr || stdout || 'unknown error'}` }
  }

  logs.push('Successfully exchanged SUI for WAL')
  return { success: true }
}

async function ensureFunds(
  network: 'mainnet' | 'testnet',
  distPath: string,
  epochs: number | 'max',
  suiKeystore: string,
  suiAddress: string,
  logs: string[]
): Promise<{ sufficient: boolean; error?: string }> {
  const rpcUrl = network === 'testnet'
    ? 'https://fullnode.testnet.sui.io:443'
    : 'https://fullnode.mainnet.sui.io:443'

  const walrusBin = `/usr/local/bin/walrus-${network}`

  const env = {
    ...process.env as Record<string, string>,
    HOME: process.env.HOME || '/root',
    PATH: `${process.env.PATH}:/usr/local/bin`,
    SUI_KEYSTORE: suiKeystore,
    SUI_ADDRESS: suiAddress,
    CI: 'true',
  }

  // 1. Deployment size
  let totalBytes: number
  try {
    totalBytes = totalDirSize(distPath)
    logs.push(`Deployment size: ${totalBytes} bytes (${(totalBytes / (1024 * 1024)).toFixed(4)} MiB)`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    logs.push(`Failed to calculate deployment size: ${msg}`)
    totalBytes = 0
  }

  // 2. Cost estimate
  const costEstimate = await estimateCost(network, totalBytes, epochs, walrusBin, env, logs)
  if (!costEstimate.success) {
    return { sufficient: false, error: costEstimate.error }
  }

  const requiredWal = costEstimate.walNeeded * 15n / 10n // 50% buffer
  logs.push(`Required WAL (with 50% buffer): ${requiredWal} FROST`)

  // 3. Current balances
  let balances: { sui: bigint; wal: bigint }
  try {
    balances = await getBalances(suiAddress, rpcUrl, logs)
    logs.push(`Balances — SUI: ${balances.sui} MIST, WAL: ${balances.wal} FROST`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    logs.push(`Balance check failed: ${msg}`)
    return { sufficient: true } // optimistic
  }

  const MIN_SUI_FOR_GAS = 50_000_000n // 0.05 SUI

  // 4. Already sufficient?
  if (balances.wal >= requiredWal) {
    if (balances.sui < MIN_SUI_FOR_GAS) {
      return {
        sufficient: false,
        error: `Insufficient SUI for gas. Have: ${balances.sui} MIST, need at least ${MIN_SUI_FOR_GAS} MIST (0.05 SUI). Please fund your wallet.`,
      }
    }
    logs.push('Sufficient WAL and SUI for deployment')
    return { sufficient: true }
  }

  const walShortfall = requiredWal - balances.wal
  logs.push(`WAL shortfall: ${walShortfall} FROST`)

  if (network === 'mainnet') {
    return {
      sufficient: false,
      error: `Insufficient WAL for mainnet deployment. Have: ${balances.wal} FROST, Need: ${requiredWal} FROST. Please acquire WAL manually.`,
    }
  }

  // Testnet — attempt SUI → WAL exchange
  if (balances.sui <= MIN_SUI_FOR_GAS) {
    return {
      sufficient: false,
      error: `Insufficient SUI to exchange for WAL. Have: ${balances.sui} MIST, need more than ${MIN_SUI_FOR_GAS} MIST after gas reserve. Please fund with testnet SUI.`,
    }
  }

  const maxSuiToExchange = balances.sui - MIN_SUI_FOR_GAS
  let suiToExchange = maxSuiToExchange > 1_000_000_000n ? 1_000_000_000n : maxSuiToExchange
  if (suiToExchange < 100_000_000n && maxSuiToExchange >= 100_000_000n) {
    suiToExchange = 100_000_000n
  }

  if (suiToExchange <= 0n) {
    return {
      sufficient: false,
      error: `Not enough SUI to exchange for WAL after gas reserve. Available: ${maxSuiToExchange} MIST.`,
    }
  }

  logs.push(`Exchanging ${suiToExchange} MIST SUI for WAL...`)
  const exchangeResult = await exchangeSuiForWal(suiToExchange, walrusBin, network, env, logs)
  if (!exchangeResult.success) {
    return {
      sufficient: false,
      error: `SUI→WAL exchange failed: ${exchangeResult.error}`,
    }
  }

  // Verify post-exchange
  try {
    const newBalances = await getBalances(suiAddress, rpcUrl, logs)
    logs.push(`Post-exchange — SUI: ${newBalances.sui} MIST, WAL: ${newBalances.wal} FROST`)

    if (newBalances.wal >= requiredWal) {
      if (newBalances.sui < MIN_SUI_FOR_GAS) {
        return { sufficient: false, error: `WAL acquired but insufficient SUI remains for gas (${newBalances.sui} MIST).` }
      }
      logs.push('Sufficient WAL after exchange')
      return { sufficient: true }
    }

    // Attempt second exchange
    const remainingSui = newBalances.sui - MIN_SUI_FOR_GAS
    if (remainingSui > 100_000_000n) {
      logs.push(`Still short, second exchange with ${remainingSui} MIST...`)
      const second = await exchangeSuiForWal(remainingSui, walrusBin, network, env, logs)
      if (second.success) {
        const finalBalances = await getBalances(suiAddress, rpcUrl, logs)
        logs.push(`Final — SUI: ${finalBalances.sui} MIST, WAL: ${finalBalances.wal} FROST`)
        if (finalBalances.wal >= requiredWal) return { sufficient: true }
      }
    }

    return {
      sufficient: false,
      error: `Insufficient WAL even after exchange. Have: ${newBalances.wal} FROST, Need: ${requiredWal} FROST. Reduce size/epochs or fund wallet.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return { sufficient: false, error: `Balance check after exchange failed: ${msg}` }
  }
}

// ───────────────────────────────────────────────────────────────
// Main deploy function
// ───────────────────────────────────────────────────────────────

function runStreamed(
  cmd: string,
  env: Record<string, string>,
  logPath: string | undefined,
  timeout = 300000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, { shell: true, env, timeout })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => {
      const text = d.toString()
      stdout += text
      if (logPath) {
        try { appendFileSync(logPath, text) } catch {}
      }
    })

    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderr += text
      if (logPath) {
        try { appendFileSync(logPath, text) } catch {}
      }
    })

    proc.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
    proc.on('error', (err) => {
      const msg = `Process error: ${err.message}\n`
      if (logPath) {
        try { appendFileSync(logPath, msg) } catch {}
      }
      resolve({ exitCode: 1, stdout, stderr })
    })
  })
}

export async function deployToWalrus(params: DeployParams): Promise<DeployResult> {
  const logs: string[] = []
  const log = (msg: string) => {
    logs.push(msg)
    console.log(msg)
    if (params.logPath) {
      try { appendFileSync(params.logPath, msg + '\n') } catch {}
    }
  }

  const { distPath, network, epochs = 'max', siteName, suiKeystore, suiAddress } = params

  log('--- Deploy ---')

  if (!existsSync(distPath)) {
    return { success: false, error: `dist path not found: ${distPath}`, logs }
  }

  if (!suiKeystore || !suiAddress) {
    return { success: false, error: 'wallet credentials not provided', logs }
  }

  // Normalize keystore format: must be JSON array ["base64key"]
  let keystoreContent = suiKeystore.trim()
  if (!keystoreContent.startsWith('[')) {
    keystoreContent = JSON.stringify([keystoreContent])
  }

  let walrusConfigPath = ''
  let tempSitesConfig = ''

  try {
    // ── 1. Walrus CLI config ──
    const walrusConfigDir = join(homedir(), '.config', 'walrus')
    mkdirSync(walrusConfigDir, { recursive: true })
    walrusConfigPath = join(walrusConfigDir, 'client_config.yaml')
    const walrusYaml = [
      'contexts:',
      '  testnet:',
      '    system_object: 0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af',
      '    staking_object: 0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3',
      '  mainnet:',
      '    system_object: 0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
      '    staking_object: 0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904',
      `default_context: ${network}`,
      '',
    ].join('\n')
    writeFileSync(walrusConfigPath, walrusYaml, { mode: 0o600 })
    log('Walrus client config written')

    // ── 2. Sui wallet setup ──
    setupWallet(network, keystoreContent, suiAddress, logs)

    // ── 3. Clean up useless files ──
    const keepFile = join(distPath, '.keep')
    if (existsSync(keepFile)) {
      unlinkSync(keepFile)
      log('Removed .keep file from dist')
    }

    // ── 4. Ensure sufficient funds ──
    const fundsResult = await ensureFunds(network, distPath, epochs, keystoreContent, suiAddress, logs)
    if (!fundsResult.sufficient) {
      return { success: false, error: fundsResult.error, logs }
    }

    // ── 5. Sites config: enable walrus_binary and walrus_config ──
    const originalSitesConfig = `/etc/walrus/sites-config-${network}.yaml`
    let sitesConfigContent = readFileSync(originalSitesConfig, 'utf-8')
    sitesConfigContent = sitesConfigContent.replace(
      /# walrus_binary:.*/,
      `walrus_binary: '/usr/local/bin/walrus-${network}'`
    )
    sitesConfigContent = sitesConfigContent.replace(
      /# walrus_config:.*/,
      `walrus_config: '${walrusConfigPath}'`
    )
    tempSitesConfig = `/tmp/sites-config-${network}.yaml`
    writeFileSync(tempSitesConfig, sitesConfigContent, { mode: 0o600 })
    log('Sites config prepared')

    // ── 6. Verify binaries ──
    const siteBuilderBin = `/usr/local/bin/site-builder-${network}`
    if (!existsSync(siteBuilderBin)) {
      return { success: false, error: `site-builder binary not found: ${siteBuilderBin}`, logs }
    }
    if (!existsSync(`/usr/local/bin/walrus-${network}`)) {
      return { success: false, error: `walrus binary not found: /usr/local/bin/walrus-${network}`, logs }
    }

    // ── 7. Build and run walrus-deploy ──
    let cmd = `walrus-deploy`
    cmd += ` --verbose`
    cmd += ` --json`
    cmd += ` --folder "${distPath}"`
    cmd += ` --network "${network}"`
    cmd += ` --epochs "${epochs}"`
    if (siteName) cmd += ` --site-name "${siteName}"`
    cmd += ` --config "${tempSitesConfig}"`

    log(`Running: ${cmd}`)

    const deployEnv = {
      ...process.env as Record<string, string>,
      HOME: process.env.HOME || '/root',
      PATH: `${process.env.PATH}:/usr/local/bin`,
      SUI_KEYSTORE: keystoreContent,
      SUI_ADDRESS: suiAddress,
      SITE_BUILDER_BIN: siteBuilderBin,
      CI: 'true',
    }

    const { exitCode, stdout, stderr } = await runStreamed(cmd, deployEnv, params.logPath)

    if (stdout) logs.push(stdout)
    if (stderr) logs.push(stderr)

    if (exitCode !== 0) {
      return { success: false, error: `site-builder deploy failed with exit code ${exitCode}`, logs }
    }

    // ── 8. Parse deploy output ──
    let objectId: string | undefined
    let base36Url: string | undefined

    // 8a. Parse JSON output file written by walrus-deploy --json
    const jsonOutputFile = '/tmp/walrus-deploy-output.json'
    if (existsSync(jsonOutputFile)) {
      try {
        const jsonContent = readFileSync(jsonOutputFile, 'utf-8')
        const jsonData = JSON.parse(jsonContent)
        if (jsonData.object_id) objectId = jsonData.object_id
        if (jsonData.base36) base36Url = jsonData.base36
        log(`Parsed JSON output: object_id=${jsonData.object_id}, base36=${jsonData.base36}`)
      } catch (err) {
        log(`Failed to parse JSON output file: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    }

    // 8b. Fallback: parse CI text output file
    if (!objectId || !base36Url) {
      const outputFile = '/tmp/walrus-deploy-output.txt'
      if (existsSync(outputFile)) {
        const output = readFileSync(outputFile, 'utf-8')
        for (const line of output.split('\n')) {
          if (line.toLowerCase().startsWith('object id:')) {
            objectId = line.split(':').slice(1).join(':').trim()
          }
          if (line.toLowerCase().startsWith('base36:')) {
            base36Url = line.split(':').slice(1).join(':').trim()
          }
        }
      }
    }

    // 8c. Fallback: parse from stdout/stderr
    if (!objectId) {
      const combined = stdout + '\n' + stderr
      const objectMatch = combined.match(/New site object ID:\s*(0x[a-f0-9]+)/i)
                        || combined.match(/Object ID:\s*(0x[a-f0-9]+)/i)
                        || combined.match(/(0x[a-f0-9]{64})/)
      if (objectMatch) objectId = objectMatch[1]
    }

    if (!base36Url) {
      const combined = stdout + '\n' + stderr
      const base36Match = combined.match(/Base36[:\s]+([a-z0-9]+)/i)
                       || combined.match(/http:\/\/([a-z0-9]+)\.localhost:3000/i)
      if (base36Match) base36Url = base36Match[1]
    }

    if (!objectId) {
      log('DEBUG: Could not parse objectId. stdout/stderr snapshot:')
      log((stdout + '\n' + stderr).slice(0, 2000))
      return { success: false, error: 'could not extract object ID from deploy output', logs }
    }

    log('Deployment successful')
    log(`Object ID: ${objectId}`)
    log(`Base36 URL: ${base36Url || 'N/A'}`)

    return { success: true, objectId, base36Url: base36Url || undefined, logs }
  } catch (err) {
    log(`Deploy exception: ${err instanceof Error ? err.message : 'unknown'}`)
    return { success: false, error: err instanceof Error ? err.message : 'deploy exception', logs }
  } finally {
    try {
      if (existsSync(walrusConfigPath)) unlinkSync(walrusConfigPath)
      if (existsSync(tempSitesConfig)) unlinkSync(tempSitesConfig)
      const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore')
      const clientYamlPath = join(homedir(), '.sui', 'sui_config', 'client.yaml')
      if (existsSync(keystorePath)) unlinkSync(keystorePath)
      if (existsSync(clientYamlPath)) unlinkSync(clientYamlPath)
      log('Secrets cleaned up')
    } catch {}
  }
}
