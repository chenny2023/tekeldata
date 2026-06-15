import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { api, getToken, setToken } from './data/api'
import Layout from './components/Layout'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Casinos from './pages/Casinos'
import Directory from './pages/Directory'
import Markets from './pages/Markets'
import Blockchain from './pages/Blockchain'
import Streamers from './pages/Streamers'
import Sentiment from './pages/Sentiment'
import Players from './pages/Players'
import Watchlist from './pages/Watchlist'
import Alerts from './pages/Alerts'
import Reports from './pages/Reports'
import ApiAccess from './pages/ApiAccess'

// Gate the whole dashboard behind a valid login: no token → straight to /login;
// a token is verified against /auth/me so an expired/invalid one also redirects.
function RequireAuth({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(getToken() ? null : false)
  useEffect(() => {
    if (!getToken()) {
      setOk(false)
      return
    }
    let alive = true
    api
      .me()
      .then(() => alive && setOk(true))
      .catch(() => {
        setToken(null) // stale/invalid token — drop it
        if (alive) setOk(false)
      })
    return () => {
      alive = false
    }
  }, [])
  if (ok === null) return <div className="grid min-h-screen place-items-center text-sm text-white/40">Loading…</div>
  if (!ok) return <Navigate to="/login" replace />
  return <>{children}</>
}

function Dashboard() {
  return (
    <Layout>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="casinos" element={<Casinos />} />
        <Route path="directory" element={<Directory />} />
        <Route path="markets" element={<Markets />} />
        <Route path="blockchain" element={<Blockchain />} />
        <Route path="streamers" element={<Streamers />} />
        <Route path="sentiment" element={<Sentiment />} />
        <Route path="players" element={<Players />} />
        <Route path="watchlist" element={<Watchlist />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="reports" element={<Reports />} />
        <Route path="api" element={<ApiAccess />} />
      </Routes>
    </Layout>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/app/*" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="*" element={<Landing />} />
    </Routes>
  )
}
