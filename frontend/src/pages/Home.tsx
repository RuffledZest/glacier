import { Link } from 'react-router-dom'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { useAuth } from '../hooks/useAuth'

const FRAMEWORKS = [
  { name: 'Next.js', icon: '▲' }, { name: 'Vite', icon: '⚡' }, { name: 'Astro', icon: '🚀' },
  { name: 'Nuxt', icon: '💚' }, { name: 'Gatsby', icon: '💜' }, { name: 'SvelteKit', icon: '🧡' },
  { name: 'Remix', icon: '💿' }, { name: 'React', icon: '⚛️' }, { name: 'Angular', icon: '🅰️' },
  { name: 'Bun', icon: '🥟' }, { name: 'Static HTML', icon: '🌐' },
]

export default function Home() {
  const { isAuthenticated } = useAuth()
  const account = useCurrentAccount()

  return (
    <div style={{ textAlign: 'center', padding: '40px 20px' }}>
      {/* Hero */}
      <div style={{ padding: '60px 0 40px' }}>
        <h1 style={{ fontSize: 48, fontWeight: 800, color: '#f0f6fc', marginBottom: 12, letterSpacing: -1 }}>
          Glacier
        </h1>
        <p style={{ fontSize: 20, color: '#8b949e', maxWidth: 560, margin: '0 auto 32px', lineHeight: 1.6 }}>
          Deploy static sites to Walrus decentralized storage. Connect your GitHub, auto-detect your framework, and ship in seconds.
        </p>

        {!account ? (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <ConnectButton connectText="Connect Phantom Wallet" />
          </div>
        ) : !isAuthenticated ? (
          <Link to="/dashboard">
            <button style={{ background: '#238636', color: '#fff', padding: '14px 36px', fontSize: 16, fontWeight: 600, borderRadius: 8 }}>
              Go to Dashboard
            </button>
          </Link>
        ) : (
          <Link to="/deploy">
            <button style={{ background: '#238636', color: '#fff', padding: '14px 36px', fontSize: 16, fontWeight: 600, borderRadius: 8 }}>
              Start Deploying
            </button>
          </Link>
        )}
      </div>

      {/* Features */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 16, maxWidth: 800, margin: '0 auto', padding: '40px 0',
      }}>
        <Feature icon="🔗" title="GitHub Integration" desc="Connect your GitHub account. Browse public & private repos. One-click deploy on push." />
        <Feature icon="🔍" title="Auto-Detect" desc="Automatically detects framework, package manager, build command, and output directory." />
        <Feature icon="☁️" title="Walrus Storage" desc="Deploy to Walrus decentralized storage on Sui. Testnet or Mainnet." />
        <Feature icon="🔐" title="Wallet Auth" desc="Sign in with your Phantom Sui wallet. Your keys, your identity." />
        <Feature icon="🔄" title="CI/CD" desc="Automatic deployments on git push via GitHub webhooks." />
        <Feature icon="🛡️" title="Secure Builds" desc="Sandboxed container builds. Keys only injected after build verification." />
      </div>

      {/* Supported frameworks */}
      <div style={{ padding: '40px 0' }}>
        <h3 style={{ fontSize: 16, color: '#8b949e', marginBottom: 20, fontWeight: 500 }}>
          Auto-detects frameworks
        </h3>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap', maxWidth: 600, margin: '0 auto' }}>
          {FRAMEWORKS.map((fw) => (
            <span key={fw.name} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', background: '#161b22', border: '1px solid #21262d',
              borderRadius: 20, fontSize: 13, color: '#c9d1d9',
            }}>
              {fw.icon} {fw.name}
            </span>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '40px 0', borderTop: '1px solid #21262d', color: '#484f58', fontSize: 12 }}>
        Powered by Walrus + Sui · Built with Cloudflare Containers
      </div>
    </div>
  )
}

function Feature({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div style={{ padding: 24, background: '#161b22', borderRadius: 10, border: '1px solid #21262d', textAlign: 'left' }}>
      <div style={{ fontSize: 24, marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#f0f6fc', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: '#8b949e', lineHeight: 1.5 }}>{desc}</div>
    </div>
  )
}
