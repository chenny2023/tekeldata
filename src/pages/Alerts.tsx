import { Navigate } from 'react-router-dom'

// Login-based per-user alert rules retired (open access). Email alerts now live on
// the consolidated Casino Alerts page.
export default function Alerts() {
  return <Navigate to="/app/watchlist" replace />
}
