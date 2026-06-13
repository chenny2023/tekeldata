import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Casinos from './pages/Casinos'
import Blockchain from './pages/Blockchain'
import Streamers from './pages/Streamers'
import Sentiment from './pages/Sentiment'
import Players from './pages/Players'
import Watchlist from './pages/Watchlist'
import Alerts from './pages/Alerts'
import Reports from './pages/Reports'
import ApiAccess from './pages/ApiAccess'

function Dashboard() {
  return (
    <Layout>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="casinos" element={<Casinos />} />
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
      <Route path="/app/*" element={<Dashboard />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  )
}
