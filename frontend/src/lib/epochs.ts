/** Keep in sync with worker/src/epochs.ts */
export const MAINNET_DAYS_PER_EPOCH = 14
export const TESTNET_DAYS_PER_EPOCH = 1

export const MAINNET_EPOCH_TIERS = [
  { epochs: 2, label: 'About 1 month' },
  { epochs: 7, label: 'About 3 months' },
  { epochs: 13, label: 'About 6 months' },
  { epochs: 26, label: 'About 1 year' },
] as const

export function mainnetTierIndexToEpochs(index: number): number {
  const i = Math.max(0, Math.min(MAINNET_EPOCH_TIERS.length - 1, Math.floor(index)))
  return MAINNET_EPOCH_TIERS[i].epochs
}

export function mainnetTierLabel(index: number): string {
  const i = Math.max(0, Math.min(MAINNET_EPOCH_TIERS.length - 1, Math.floor(index)))
  return MAINNET_EPOCH_TIERS[i].label
}

/** Calendar date ~duration from today (local), for UX only */
export function formatApproxActiveUntilDate(daysFromNow: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + daysFromNow)
  return d.toLocaleDateString(undefined, { dateStyle: 'long' })
}

export function activeRetentionDays(network: 'mainnet' | 'testnet', mainnetTierIndex: number, testnetDays: number): number {
  if (network === 'mainnet') {
    return mainnetTierIndexToEpochs(mainnetTierIndex) * MAINNET_DAYS_PER_EPOCH
  }
  return Math.max(1, Math.min(7, testnetDays)) * TESTNET_DAYS_PER_EPOCH
}
