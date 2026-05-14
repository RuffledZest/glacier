/** Walrus mainnet: ~14 days per storage epoch */
export const MAINNET_DAYS_PER_EPOCH = 14
/** Walrus testnet: ~1 day per storage epoch */
export const TESTNET_DAYS_PER_EPOCH = 1

/** Ordered tiers: epochs passed to walrus-deploy / used for cost math */
export const MAINNET_EPOCH_TIERS = [
  { epochs: 2, label: 'About 1 month' },
  { epochs: 7, label: 'About 3 months' },
  { epochs: 13, label: 'About 6 months' },
  { epochs: 26, label: 'About 1 year' },
] as const

export const MAINNET_ALLOWED_EPOCHS = MAINNET_EPOCH_TIERS.map((t) => t.epochs) as readonly number[]

const ALLOWED_SET = new Set(MAINNET_ALLOWED_EPOCHS)

/**
 * Mainnet: missing → 2 (minimum). `"max"` → 26 (legacy). Integer must be in allowed set.
 */
export function resolveMainnetEpochs(
  input: unknown,
): { ok: true; epochs: number } | { ok: false; error: string } {
  if (input === undefined || input === null) {
    return { ok: true, epochs: 2 }
  }
  if (input === 'max') {
    return { ok: true, epochs: 26 }
  }
  if (typeof input === 'number' && Number.isInteger(input)) {
    if (ALLOWED_SET.has(input)) return { ok: true, epochs: input }
    return {
      ok: false,
      error: `mainnet epochs must be one of: ${MAINNET_ALLOWED_EPOCHS.join(', ')} (or omit for minimum, or "max" for legacy)`,
    }
  }
  return { ok: false, error: 'mainnet epochs must be an integer, omitted, or "max"' }
}

/** Testnet: 1–7 (≈ days). Missing / invalid → 1 */
export function resolveTestnetEpochs(input: unknown): number {
  if (typeof input === 'number' && Number.isInteger(input)) {
    return Math.max(1, Math.min(7, input))
  }
  return 1
}
