import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import ButtonBg from '/ButtonBgPng.webp'

export default function Home() {
  const navigate = useNavigate()
  const { isAuthenticated, githubLogin, isCheckingProfile, login, isConnecting } = useAuth()
  const isGithubConnected = isAuthenticated && !!githubLogin

  useEffect(() => {
    if (isGithubConnected && !isCheckingProfile) {
      navigate('/dashboard', { replace: true })
    }
  }, [isGithubConnected, isCheckingProfile, navigate])

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#050B14]">
      {/* Background layer */}
      <picture className="absolute inset-0 z-0 block h-full w-full">
        <source srcSet="/BackgroundSkyAndBeam.avif" type="image/avif" />
        <source srcSet="/BackgroundSkyAndBeam.webp" type="image/webp" />
        <img
          src="/BackgroundSkyAndBeam.png"
          alt=""
          aria-hidden="true"
          width={5808}
          height={3740}
          decoding="async"
          fetchPriority="high"
          draggable={false}
          className="h-full w-full object-cover object-center select-none"
        />
      </picture>

      {/* Logo text - Layered behind glacier (z-10) */}
      <div className="absolute top-[35%] left-1/2 -translate-x-1/2 w-full z-10 flex items-center justify-center select-none ">
        <span className="font-koulen text-[120px] sm:text-[180px] lg:text-[240px] leading-none text-white tracking-wider">P</span>
        <img src="/PolarSvg.svg" alt="Polar Logo" className="w-[90px] h-[90px] sm:w-[135px] sm:h-[135px] lg:w-[220px] lg:h-[220px] object-contain mx-1 sm:mx-2 drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]" />
        <span className="font-koulen text-[120px] sm:text-[180px] lg:text-[240px] leading-none text-white tracking-wider">LAR</span>
      </div>

      {/* Foreground glacier layer (z-20) with slide-up animation */}
      <img
        src="/GlacierNoBg.png"
        alt=""
        aria-hidden="true"
        width={2462}
        height={1664}
        decoding="async"
        draggable={false}
        className="absolute bottom-[-5%] left-0 right-0 z-20 h-[70%] w-full object-cover object-top pointer-events-none select-none md:h-[95%] animate-glacier-slide-up"
      />

      {/* Button - Moved to 85% from top (z-30) */}
      <div className="absolute top-[50vh] sm:top-[68vh] left-1/2 -translate-x-1/2 z-30">
        {!isGithubConnected ? (
          <button
            type="button"
            onClick={() => void login()}
            disabled={isConnecting || isCheckingProfile}
            className="relative group transition-all duration-300 hover:scale-105 active:scale-95 flex items-center justify-center px-9 sm:px-16 lg:px-24 py-12 sm:py-10 lg:py-12 font-normal text-lg sm:text-2xl md:text-3xl text-white drop-shadow-lg disabled:opacity-70 disabled:cursor-not-allowed"
            style={{ backgroundImage: `url(${ButtonBg})`, backgroundSize: "100%", backgroundRepeat: "no-repeat", backgroundPosition: "center" }}
          >
            {isCheckingProfile ? 'Checking GitHub…' : isConnecting ? 'Redirecting…' : 'Connect GitHub'}
          </button>
        ) : (
          <Link to="/dashboard">
            <button
              className="relative group transition-all duration-300 hover:scale-105 active:scale-95 flex items-center justify-center px-12 py-5 font-sans font-medium text-lg sm:text-xl text-white drop-shadow-lg"
              style={{ backgroundImage: `url(${ButtonBg})`, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' }}
            >
              Go To Dashboard
            </button>
          </Link>
        )}
      </div>

      {/* Subtext - At bottom most (z-30) */}
      <p className="absolute bottom-6 left-1/2 -translate-x-1/2 w-full text-white/90 text-sm sm:text-lg font-sans font-regular tracking-wide text-center z-30">
        Polar let's you deploy you  web apps on Walrus within seconds
      </p>
    </div>
  )
}
