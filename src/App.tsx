import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
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

// Open-access: the dashboard and all data are public (no login). Email is only
// collected at the point of subscribing to reports / per-casino alerts.

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
      <Route path="/app/*" element={<Dashboard />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  )
}
