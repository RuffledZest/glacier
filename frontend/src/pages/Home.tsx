import { Link } from 'react-router-dom'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { useAuth } from '../hooks/useAuth'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Zap, Cloud, Lock, GitMerge, ShieldCheck, Triangle, Zap as ZapIcon, Rocket, CircleDashed, Globe } from 'lucide-react'

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
      <path d="M9 18c-4.51 2-5-2-7-2"/>
    </svg>
  )
}

const FRAMEWORKS = [
  { name: 'Next.js', icon: <Triangle className="w-4 h-4" /> },
  { name: 'Vite', icon: <ZapIcon className="w-4 h-4 text-yellow-400" /> },
  { name: 'Astro', icon: <Rocket className="w-4 h-4 text-orange-500" /> },
  { name: 'Nuxt', icon: <CircleDashed className="w-4 h-4 text-green-500" /> },
  { name: 'Gatsby', icon: <div className="w-4 h-4 rounded-full bg-purple-500" /> },
  { name: 'SvelteKit', icon: <div className="w-4 h-4 rounded-sm bg-orange-600" /> },
  { name: 'Remix', icon: <div className="w-4 h-4 rounded-full border-2 border-white" /> },
  { name: 'React', icon: <div className="w-4 h-4 rounded-full bg-blue-400 animate-pulse-fast" /> },
  { name: 'Angular', icon: <div className="w-4 h-4 rounded-sm bg-red-600" /> },
  { name: 'Static HTML', icon: <Globe className="w-4 h-4 text-gray-400" /> },
]

export default function Home() {
  const { isAuthenticated } = useAuth()
  const account = useCurrentAccount()

  return (
    <div className="flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8">
      {/* Hero */}
      <div className="text-center max-w-3xl mb-24">
        <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight text-white mb-6">
          Deploy to <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-primary">Walrus</span> in seconds.
        </h1>
        <p className="text-xl text-textMuted mb-10 max-w-2xl mx-auto leading-relaxed">
          Connect your GitHub, auto-detect your framework, and ship your static sites to decentralized storage on Sui. No config required.
        </p>

        <div className="flex justify-center gap-4">
          {!account ? (
            <ConnectButton />
          ) : !isAuthenticated ? (
            <Link to="/dashboard">
              <Button size="lg" className="px-8 font-semibold text-base shadow-lg shadow-primary/20">
                Go to Dashboard
              </Button>
            </Link>
          ) : (
            <Link to="/deploy">
              <Button size="lg" className="px-8 font-semibold text-base shadow-lg shadow-primary/20">
                Start Deploying
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* Features Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full max-w-5xl mb-24">
        <FeatureCard 
          icon={<GithubIcon className="w-6 h-6" />}
          title="GitHub Integration" 
          desc="Connect your GitHub account. Browse public & private repos. Deploy instantly on every push." 
        />
        <FeatureCard 
          icon={<Zap className="w-6 h-6 text-yellow-500" />}
          title="Zero Config" 
          desc="Automatically detects framework, package manager, build command, and output directory." 
        />
        <FeatureCard 
          icon={<Cloud className="w-6 h-6 text-blue-400" />}
          title="Decentralized Storage" 
          desc="Deploy directly to Walrus on Sui. Choose between Testnet and Mainnet environments." 
        />
        <FeatureCard 
          icon={<Lock className="w-6 h-6 text-purple-400" />}
          title="Wallet Auth" 
          desc="Sign in securely with your Phantom Sui wallet. Your keys, your identity, your deployments." 
        />
        <FeatureCard 
          icon={<GitMerge className="w-6 h-6 text-green-400" />}
          title="Automated CI/CD" 
          desc="Set it and forget it. We handle automatic deployments via secure GitHub webhooks." 
        />
        <FeatureCard 
          icon={<ShieldCheck className="w-6 h-6 text-red-400" />}
          title="Secure Sandboxed Builds" 
          desc="Cloudflare containers ensure clean builds. Keys are only injected after verification." 
        />
      </div>

      {/* Frameworks */}
      <div className="w-full max-w-3xl text-center mb-16">
        <h3 className="text-sm font-semibold tracking-widest text-textMuted uppercase mb-8">
          Frameworks we auto-detect
        </h3>
        <div className="flex flex-wrap justify-center gap-3">
          {FRAMEWORKS.map((fw) => (
            <Badge key={fw.name} variant="outline" className="px-4 py-2 text-sm bg-surface/50 gap-2 border-border/50 hover:bg-surface transition-colors">
              {fw.icon}
              {fw.name}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  )
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <Card className="bg-surface/50 hover:bg-surface transition-colors border-border/50">
      <div className="p-6">
        <div className="w-12 h-12 rounded-lg bg-background border border-border flex items-center justify-center mb-6">
          {icon}
        </div>
        <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
        <p className="text-sm text-textMuted leading-relaxed">{desc}</p>
      </div>
    </Card>
  )
}
