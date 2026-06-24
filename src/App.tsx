import { Suspense, lazy, useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { api, getToken, setToken } from './data/api'
import Layout from './components/Layout'
import { BrandLoader } from './components/BrandLoader'
import Landing from './pages/Landing'
import Login from './pages/Login'

// Code-split the dashboard pages: the landing/login load instantly, and each
// dashboard view's JS is fetched on demand — a much smaller initial bundle.
const Overview = lazy(() => import('./pages/Overview'))
const Casinos = lazy(() => import('./pages/Casinos'))
const Directory = lazy(() => import('./pages/Directory'))
const Markets = lazy(() => import('./pages/Markets'))
const Blockchain = lazy(() => import('./pages/Blockchain'))
const Streamers = lazy(() => import('./pages/Streamers'))
const Sentiment = lazy(() => import('./pages/Sentiment'))
const Players = lazy(() => import('./pages/Players'))
const Watchlist = lazy(() => import('./pages/Watchlist'))
const Alerts = lazy(() => import('./pages/Alerts'))
const Reports = lazy(() => import('./pages/Reports'))
const Daily = lazy(() => import('./pages/Daily'))

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
  if (ok === null) return <BrandLoader full label="Verifying your session…" />
  if (!ok) return <Navigate to="/login" replace />
  return <>{children}</>
}

function Dashboard() {
  return (
    <Layout>
      <Suspense fallback={<BrandLoader />}>
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
        {/* API Access retired (1.0): not productizing a public API. Redirect old links. */}
        <Route path="api" element={<Navigate to="/app" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/daily"
        element={
          <Suspense fallback={<BrandLoader full />}>
            <Daily />
          </Suspense>
        }
      />
      <Route path="/login" element={<Login />} />
      <Route path="/app/*" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="*" element={<Landing />} />
    </Routes>
  )
}
