export function encodeRepoUrl(repoUrl: string): string {
  try {
    return btoa(repoUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  } catch {
    return encodeURIComponent(repoUrl)
  }
}

export function decodeRepoUrl(encoded: string): string {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4))
    return atob(base64 + pad)
  } catch {
    return decodeURIComponent(encoded)
  }
}

export function repoDisplay(url: string): string {
  return url.split('/').slice(-2).join('/').replace('.git', '')
}

export function repoOwner(url: string): string {
  return url.split('/').slice(-2, -1)[0] || ''
}

export function repoName(url: string): string {
  return url.split('/').slice(-1)[0]?.replace('.git', '') || ''
}
