// Branded page/route loading state — the same flipping Tekel Data gold coin as the boot
// splash (index.html), reused across the app so every loading moment is on-brand.
// `full` = fixed full-screen overlay (auth gate, lazy page chunks); otherwise it
// fills its container (e.g. the dashboard content area while a route chunk loads).
export function BrandLoader({ label = 'Loading on-chain intelligence…', full = false }: { label?: string; full?: boolean }) {
  return (
    <div className={`brand-loader${full ? ' bl-full' : ''}`} role="status" aria-busy="true" aria-live="polite">
      <div className="bl-coin">
        <svg width="52" height="52" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <polygon points="48,18 42,32 54,32" fill="#F2C200" />
          <rect x="45" y="32" width="6" height="46" fill="#F2C200" />
          <rect x="30" y="78" width="36" height="5" rx="2.5" fill="#F2C200" />
          <g transform="rotate(9 48 33)">
            <rect x="12" y="31" width="72" height="5" rx="2.5" fill="#F2C200" />
            <line x1="26" y1="36" x2="26" y2="40" stroke="#F2C200" strokeWidth="2" />
            <line x1="75" y1="36" x2="75" y2="44" stroke="#F2C200" strokeWidth="2" />
            <rect x="17" y="47" width="5" height="10" fill="#F2C200" />
            <rect x="24" y="43" width="5" height="14" fill="#F2C200" />
            <rect x="31" y="39" width="5" height="18" fill="#F2C200" />
            <rect x="72" y="45" width="5" height="8" fill="#6E6E68" />
          </g>
        </svg>
      </div>
      <div className="bl-tag">{label}</div>
      <div className="bl-bar" />
    </div>
  )
}
