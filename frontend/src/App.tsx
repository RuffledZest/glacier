import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Dashboard from './pages/Dashboard'
import Deploy from './pages/Deploy'
import DeploymentDetail from './pages/DeploymentDetail'

function RedirectToDeploy() {
  const location = useLocation()
  return <Navigate to={`/deploy${location.search}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/repos" element={<RedirectToDeploy />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/deploy" element={<Deploy />} />
          <Route path="/deployments/:id" element={<DeploymentDetail />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
