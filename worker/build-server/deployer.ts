import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface DeployParams {
  distPath: string
  network: 'mainnet' | 'testnet'
  epochs?: number | 'max'
  siteName?: string
  suiKeystore: string
  suiAddress: string
}

export interface DeployResult {
  success: boolean
  objectId?: string
  base36Url?: string
  error?: string
  logs: string[]
}

export async function deployToWalrus(params: DeployParams): Promise<DeployResult> {
  const logs: string[] = []
  const log = (msg: string) => { logs.push(msg); console.log(msg) }

  const { distPath, network, epochs = 'max', siteName, suiKeystore, suiAddress } = params

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
    // ── Walrus CLI config (required by walrus binary called from site-builder) ──
    // site-builder passes --context <network> to walrus, so we must write a valid
    // MultiClientConfig with contexts + default_context. The walrus binary auto-
    // detects network defaults (rpc_urls, exchange_objects, n_shards, etc.) when
    // the exact system_object / staking_object IDs are provided.
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

    // ── sites-config: enable walrus_binary and walrus_config ──
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

    // ── Verify binaries ──
    const siteBuilderBin = `/usr/local/bin/site-builder-${network}`
    if (!existsSync(siteBuilderBin)) {
      return { success: false, error: `site-builder binary not found: ${siteBuilderBin}`, logs }
    }
    if (!existsSync(`/usr/local/bin/walrus-${network}`)) {
      return { success: false, error: `walrus binary not found: /usr/local/bin/walrus-${network}`, logs }
    }

    // ── Build command using walrus-deploy script ──
    // The script's CI mode (setup_ci_keystore) handles wallet setup from
    // SUI_KEYSTORE / SUI_ADDRESS env vars — we don't pass --wallet/--wallet-address.
    let cmd = `walrus-deploy`
    cmd += ` --verbose`
    cmd += ` --folder "${distPath}"`
    cmd += ` --network "${network}"`
    cmd += ` --epochs "${epochs}"`
    if (siteName) cmd += ` --site-name "${siteName}"`
    cmd += ` --config "${tempSitesConfig}"`

    log(`Running: ${cmd}`)

    const result = spawnSync(cmd, {
      shell: true,
      env: {
        ...process.env as Record<string, string>,
        HOME: process.env.HOME || '/root',
        PATH: `${process.env.PATH}:/usr/local/bin`,
        // walrus-deploy CI mode — the script auto-configures Sui keystore + client.yaml
        SUI_KEYSTORE: keystoreContent,
        SUI_ADDRESS: suiAddress,
        // site-builder / walrus binary overrides
        SITE_BUILDER_BIN: siteBuilderBin,
        CI: 'true',
      },
      timeout: 300000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })

    const stdout = result.stdout?.trim() || ''
    const stderr = result.stderr?.trim() || ''

    log(stdout)
    if (stderr) log(stderr)

    if (result.status !== 0) {
      const errorOutput = [stdout, stderr].filter(Boolean).join('\n')
      return { success: false, error: `deploy failed:\n${errorOutput}`, logs }
    }

    // ── Parse deploy output ──
    let objectId: string | undefined
    let base36Url: string | undefined

    const outputFile = '/tmp/walrus-deploy-output.txt'
    if (existsSync(outputFile)) {
      const output = readFileSync(outputFile, 'utf-8')
      for (const line of output.split('\n')) {
        if (line.startsWith('OBJECT_ID=')) objectId = line.split('=')[1]?.trim()
        if (line.startsWith('BASE36_URL=')) base36Url = line.split('=')[1]?.trim()
      }
    }

    // Fallback: parse from stdout
    if (!objectId || !base36Url) {
      const combined = stdout + '\n' + stderr
      const objectMatch = combined.match(/Object ID:\s*([a-f0-9]+)/i)
                        || combined.match(/([a-f0-9]{64})/)
      if (objectMatch) objectId = objectMatch[1]

      const urlMatch = combined.match(/https?:\/\/[^\s]+\.wal\.app[^\s]*/i)
                     || combined.match(/([a-z0-9]+\.wal\.app)/i)
                     || combined.match(/Base36[:\s]+([a-z0-9]+)/i)
      if (urlMatch) base36Url = urlMatch[0]
    }

    if (!objectId) {
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
    // Clean up config files
    try {
      if (existsSync(walrusConfigPath)) unlinkSync(walrusConfigPath)
      if (existsSync(tempSitesConfig)) unlinkSync(tempSitesConfig)
      // Clean up Sui wallet files written by walrus-deploy's setup_ci_keystore
      const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore')
      const clientYamlPath = join(homedir(), '.sui', 'sui_config', 'client.yaml')
      if (existsSync(keystorePath)) unlinkSync(keystorePath)
      if (existsSync(clientYamlPath)) unlinkSync(clientYamlPath)
      log('Secrets cleaned up')
    } catch {}
  }
}
