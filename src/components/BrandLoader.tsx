// Branded page/route loading state — the same flipping WCOIN gold coin as the boot
// splash (index.html), reused across the app so every loading moment is on-brand.
// `full` = fixed full-screen overlay (auth gate, lazy page chunks); otherwise it
// fills its container (e.g. the dashboard content area while a route chunk loads).
export function BrandLoader({ label = 'Loading on-chain intelligence…', full = false }: { label?: string; full?: boolean }) {
  return (
    <div className={`brand-loader${full ? ' bl-full' : ''}`} role="status" aria-busy="true" aria-live="polite">
      <div className="bl-coin">
        <b>W</b>
      </div>
      <div className="bl-tag">{label}</div>
      <div className="bl-bar" />
    </div>
  )
}
