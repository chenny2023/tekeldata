import { ReactNode, HTMLAttributes } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { CHAIN_COLOR } from '../data/format'

// ── Brand mark ────────────────────────────────────────────────────────────────
export function Logo({ size = 30, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <div
        className="relative grid place-items-center rounded-xl ring-gold"
        style={{
          width: size,
          height: size,
          background: 'radial-gradient(circle at 30% 25%, #ffe27a, #f5b100 55%, #b87b00)',
        }}
      >
        <span
          className="font-display font-bold text-ink-950"
          style={{ fontSize: size * 0.52, lineHeight: 1 }}
        >
          W
        </span>
      </div>
      {withText && (
        <div className="leading-none">
          <span className="font-display text-[17px] font-bold tracking-tight">
            WCOIN<span className="text-gradient-gold">.CASINO</span>
          </span>
        </div>
      )}
    </div>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────
export function Card({
  children,
  className = '',
  hover = false,
  ...rest
}: {
  children: ReactNode
  className?: string
  hover?: boolean
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`glass ${hover ? 'glass-hover' : ''} rounded-2xl ${className}`} {...rest}>{children}</div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
export function StatCard({
  label,
  value,
  delta,
  icon,
  accent = 'gold',
}: {
  label: string
  value: string
  delta?: number
  icon?: ReactNode
  accent?: 'gold' | 'violet' | 'mint'
}) {
  const ring =
    accent === 'gold'
      ? 'from-gold-500/20'
      : accent === 'violet'
        ? 'from-violet-500/20'
        : 'from-mint-400/20'
  return (
    <Card hover className="p-4 sm:p-5 relative overflow-hidden">
      <div className={`absolute -top-10 -right-10 h-28 w-28 rounded-full bg-gradient-to-br ${ring} to-transparent blur-2xl`} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] uppercase tracking-wider text-white/45">{label}</div>
          <div className="mt-1.5 font-display text-2xl font-bold">{value}</div>
        </div>
        {icon && (
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-white/5 text-gold-400">
            {icon}
          </div>
        )}
      </div>
      {delta !== undefined && <Delta value={delta} className="mt-2" />}
    </Card>
  )
}

export function Delta({ value, className = '' }: { value: number; className?: string }) {
  const up = value >= 0
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-semibold ${
        up ? 'bg-mint-400/12 text-mint-400' : 'bg-rose-400/12 text-rose-400'
      } ${className}`}
    >
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {Math.abs(value).toFixed(1)}%
    </span>
  )
}

// ── Trust meter ───────────────────────────────────────────────────────────────
export function TrustBadge({ score }: { score: number }) {
  const color = score >= 85 ? '#2ee6a6' : score >= 70 ? '#f5b100' : '#ff5c7a'
  return (
    <div className="inline-flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="text-[13px] font-semibold tabular-nums" style={{ color }}>
        {score}
      </span>
    </div>
  )
}

// ── Chain pill ────────────────────────────────────────────────────────────────
export function ChainPill({ chain }: { chain: string }) {
  const c = CHAIN_COLOR[chain] ?? '#888'
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
      style={{ background: `${c}1f`, color: c }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {chain}
    </span>
  )
}

// ── Logo bubble (initials) ────────────────────────────────────────────────────
export function Bubble({ seed, size = 34 }: { seed: string; size?: number }) {
  const hues = [265, 45, 160, 22, 220, 320]
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h + seed.charCodeAt(i)) % hues.length
  const hue = hues[h]
  const initials = seed
    .split(/[\s_]/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <div
      className="grid shrink-0 place-items-center rounded-lg font-display text-[13px] font-bold text-white"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg, hsl(${hue} 70% 42%), hsl(${(hue + 30) % 360} 70% 28%))`,
      }}
    >
      {initials}
    </div>
  )
}

// ── Section heading ───────────────────────────────────────────────────────────
export function PageHead({
  title,
  subtitle,
  right,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-white/50">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-mint-400/30 bg-mint-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-mint-400">
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-mint-400" />
      Live
    </span>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-white/6 ${className}`} />
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-white/25">{icon}</div>}
      <div className="font-display text-lg font-semibold text-white/70">{title}</div>
      {hint && <p className="mt-1 max-w-sm text-sm text-white/40">{hint}</p>}
    </div>
  )
}

const CATEGORY_STYLE: Record<string, string> = {
  casino: 'bg-violet-500/15 text-violet-300',
  exchange: 'bg-gold-500/15 text-gold-400',
  whale: 'bg-mint-400/12 text-mint-400',
  other: 'bg-white/8 text-white/55',
}
export function CategoryBadge({ category }: { category: string }) {
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold capitalize ${CATEGORY_STYLE[category] ?? CATEGORY_STYLE.other}`}>
      {category}
    </span>
  )
}

export function ComplianceTag({ status }: { status: 'clear' | 'review' | 'flagged' }) {
  const map = {
    clear: ['Clear', 'text-mint-400 bg-mint-400/12'],
    review: ['Review', 'text-gold-400 bg-gold-400/12'],
    flagged: ['Flagged', 'text-rose-400 bg-rose-400/12'],
  } as const
  const [label, cls] = map[status]
  return <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>
}
