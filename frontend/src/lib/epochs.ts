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

/** Calendar days from epoch count (same model as cost/deploy). */
export function walrusRetentionCalendarDays(network: 'mainnet' | 'testnet', epochs: number): number {
  if (network === 'mainnet') return epochs * MAINNET_DAYS_PER_EPOCH
  return Math.max(1, Math.min(7, epochs)) * TESTNET_DAYS_PER_EPOCH
}

/** End-of-retention instant = deploy time + calendar-day estimate (Walrus uses chain epochs; this is UX-only). */
export function approxWalStorageEndDate(
  deployedAtIso: string,
  network: 'mainnet' | 'testnet',
  epochs: number | null | undefined,
): Date {
  const e =
    epochs != null && Number.isFinite(epochs) && epochs > 0
      ? epochs
      : network === 'mainnet'
        ? 2
        : 1
  const days = walrusRetentionCalendarDays(network, e)
  return new Date(new Date(deployedAtIso).getTime() + days * 86_400_000)
}
