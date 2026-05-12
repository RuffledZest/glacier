import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { getDeployment, deleteDeployment, retryDeployment, getToken, type Deployment } from '../lib/api'
import { ansiToHtml } from '../lib/ansi'
import { useSSE } from '../hooks/useSSE'

const STATUS: Record<string, { color: string; label: string }> = {
  queued:    { color: '#8b949e', label: 'Queued' },
  building:  { color: '#d29922', label: 'Building' },
  built:     { color: '#58a6ff', label: 'Built' },
  deploying: { color: '#d29922', label: 'Deploying' },
  deployed:  { color: '#3fb950', label: 'Live' },
  failed:    { color: '#f85149', label: 'Failed' },
}

function repoDisplay(url: string): string {
  return url.split('/').slice(-2).join('/').replace('.git', '')
}

export default function DeploymentDetail() {
  const { id } = useParams<{ id: string }>()
  const { isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const [d, setD] = useState<Deployment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [liveLogs, setLiveLogs] = useState('')
  const [sseDone, setSseDone] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const isLive = !!(d && d.status === 'building')
  const hasError = !!(d && d.status === 'failed')

  // Reset local state when switching deployments
  useEffect(() => {
    setLiveLogs('')
    setSseDone(false)
    setLoading(true)
  }, [id])

  // SSE only during active build
  useSSE({
    url: isLive ? `${import.meta.env.VITE_API_BASE || '/api'}/deployments/${id}/logs` : '',
    token: getToken() || '',
    onMessage: (text) => {
      setLiveLogs((prev) => {
        const next = prev + text
        // Keep only last 100K chars to prevent memory issues
        return next.length > 100_000 ? next.slice(-100_000) : next
      })
    },
    onDone: () => {
      setSseDone(true)
      // Refresh final state from D1 with retries — worker may still be writing logs
      if (id) {
        let attempts = 0
        const fetchWithRetry = async () => {
          try {
            const dep = await getDeployment(id)
            setD(dep)
            // If worker hasn't finished writing final logs yet, retry
            if (['building', 'built', 'deploying'].includes(dep.status) && attempts < 5) {
              attempts++
              setTimeout(fetchWithRetry, 1500)
            }
          } catch {}
        }
        fetchWithRetry()
      }
    },
  })

  // Auto-scroll logs
  useEffect(() => {
    if (liveLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [liveLogs])

  // Status polling during all active phases
  useEffect(() => {
    if (!id || !isAuthenticated) return
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const dep = await getDeployment(id)
        setD(dep)
        setError(null)
        if (['queued', 'building', 'built', 'deploying'].includes(dep.status)) {
          timer = setTimeout(poll, 3000)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    }
    poll()
    return () => clearTimeout(timer)
  }, [id, isAuthenticated])

  async function handleDelete() {
    if (!id || !confirm('Delete this deployment? This cannot be undone.')) return
    setDeleting(true)
    try { await deleteDeployment(id); navigate('/dashboard') }
    catch (err) { alert(err instanceof Error ? err.message : 'Delete failed'); setDeleting(false) }
  }

  async function handleRetry() {
    if (!id) return
    setRetrying(true)
    try {
      const { id: newId } = await retryDeployment(id)
      navigate(`/deployments/${newId}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Retry failed')
      setRetrying(false)
    }
  }

  if (!isAuthenticated) return <p style={{ color: '#8b949e', textAlign: 'center', padding: 40 }}>Sign in to view.</p>
  if (loading) return <p style={{ color: '#8b949e', textAlign: 'center', padding: 40 }}>Loading...</p>
  if (error || !d) return (
    <div style={{ textAlign: 'center', padding: 40 }}>
      <p style={{ color: '#f85149', marginBottom: 16 }}>{error || 'Not found'}</p>
      <Link to="/dashboard" style={{ color: '#58a6ff' }}>Back to dashboard</Link>
    </div>
  )

  const s = STATUS[d.status] || { color: '#8b949e', label: d.status }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Link to="/dashboard" style={{ fontSize: 13, color: '#8b949e', display: 'inline-block', marginBottom: 20 }}>
        &larr; Back to dashboard
      </Link>

      <div style={{ padding: 28, background: '#161b22', borderRadius: 12, border: '1px solid #21262d' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f0f6fc', marginBottom: 6 }}>
              {repoDisplay(d.repoUrl)}
            </h2>
            <div style={{ fontSize: 13, color: '#8b949e', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{d.repoUrl}</span>
              <span>·</span>
              <span>{d.branch}</span>
              <span>·</span>
              <span>{d.network === 'testnet' ? '🧪 Testnet' : '🌐 Mainnet'}</span>
            </div>
          </div>
          <span style={{
            padding: '6px 16px', borderRadius: 20, fontSize: 13, fontWeight: 700,
            background: `${s.color}18`, color: s.color, textTransform: 'uppercase', letterSpacing: 0.5,
          }}>
            {s.label}
          </span>
        </div>

        {/* Success box */}
        {d.status === 'deployed' && d.base36Url && (
          <div style={{
            padding: 20, background: '#0d2b1a', borderRadius: 10, border: '1px solid #238636',
            marginBottom: 24,
          }}>
            <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
              Live URL
            </div>
            <a
              href={`https://${d.base36Url}.wal.app`}
              target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 18, fontWeight: 700, color: '#3fb950', wordBreak: 'break-all' }}
            >
              {d.base36Url}.wal.app
            </a>
            {d.objectId && (
              <div style={{ fontSize: 11, color: '#8b949e', marginTop: 8, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                Object ID: {d.objectId}
              </div>
            )}
          </div>
        )}

        {/* Error box */}
        {d.error && (
          <div style={{
            padding: 16, background: '#490202', border: '1px solid #f85149',
            borderRadius: 8, color: '#f85149', fontSize: 13, marginBottom: 24, whiteSpace: 'pre-wrap',
          }}>
            {d.error}
          </div>
        )}

        {/* Info grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 32px',
          padding: '20px 0', borderTop: '1px solid #21262d', borderBottom: '1px solid #21262d',
          marginBottom: 20,
        }}>
          <Info label="Install" value={d.installCommand || 'auto'} />
          <Info label="Build" value={d.buildCommand || 'auto'} />
          <Info label="Output" value={d.outputDir || 'auto'} />
          <Info label="Base Dir" value={d.baseDir} />
          <Info label="Deploy ID" value={d.id.slice(0, 8) + '...'} />
          <Info label="Created" value={new Date(d.createdAt).toLocaleString()} />
          <Info label="Updated" value={new Date(d.updatedAt).toLocaleString()} />
          <Info label="Network" value={d.network} />
        </div>

        {/* Build logs — always expanded during live stream or when there's an error */}
        <details open={isLive || hasError} style={{ marginBottom: 24 }}>
          <summary style={{ fontSize: 13, color: '#58a6ff', cursor: 'pointer', marginBottom: 10 }}>
            Build Logs {isLive && <span style={{ color: '#d29922', fontSize: 11 }}>● Live</span>}
          </summary>
          <div style={{
            background: '#0d1117', borderRadius: 8, border: '1px solid #21262d',
            maxHeight: 500, overflow: 'auto', position: 'relative',
          }}>
            <pre
              dangerouslySetInnerHTML={{
                __html: ansiToHtml(liveLogs || d.logs || 'No logs available.'),
              }}
              style={{
                margin: 0, padding: 16, fontSize: 12, color: '#c9d1d9',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6,
                fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", monospace',
                minHeight: 60,
              }}
            />
            <div ref={logsEndRef} />
          </div>
        </details>

        {/* Actions */}
        <div style={{ borderTop: '1px solid #21262d', paddingTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {d.status === 'failed' && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              style={{
                background: retrying ? '#21262d' : '#1f6feb',
                color: retrying ? '#484f58' : '#fff',
                border: `1px solid ${retrying ? '#21262d' : '#1f6feb'}`,
                padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              }}
            >
              {retrying ? 'Retrying...' : 'Retry Deployment'}
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              background: deleting ? '#21262d' : '#490202',
              color: deleting ? '#484f58' : '#f85149',
              border: `1px solid ${deleting ? '#21262d' : '#f85149'}`,
              padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            }}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#c9d1d9' }}>{value || '—'}</div>
    </div>
  )
}
