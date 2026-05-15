/**
 * Build `outputDir` must be relative to the app directory (e.g. `dist`), not an absolute
 * `/tmp/builds/<id>/repo/...` path. Older builds wrongly stored `distPath` in D1; joining
 * `workingDir` with an absolute path ignores `workingDir` and keeps the stale path.
 */
export function coerceRelativeOutputDir(
  outputDir: string | null | undefined,
  baseDir: string,
): string | undefined {
  if (outputDir == null) return undefined
  const o = outputDir.trim().replace(/\\/g, '/')
  if (o === '') return undefined

  if (!o.startsWith('/')) return o

  const marker = '/repo/'
  const idx = o.indexOf(marker)
  if (idx === -1) {
    const parts = o.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1] : 'dist'
  }

  let rest = o.slice(idx + marker.length)
  const base = baseDir === '.' ? '' : baseDir.replace(/^\/+|\/+$/g, '')
  if (base && rest.startsWith(`${base}/`)) {
    rest = rest.slice(base.length + 1)
  } else if (base && rest === base) {
    return 'dist'
  }
  return rest || 'dist'
}
