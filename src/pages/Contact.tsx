import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Mail, MessageSquare } from 'lucide-react'
import { Logo, Card } from '../components/ui'

export default function Contact() {
  const [sent, setSent] = useState(false)

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/7 bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
          <Link to="/"><Logo /></Link>
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white">
            <ArrowLeft size={15} /> Back
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-5xl gap-8 px-5 py-16 lg:grid-cols-2">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-gold-500/30 bg-gold-500/10 px-3 py-1 text-[12px] font-semibold uppercase tracking-wider text-gold-400">
            <MessageSquare size={13} /> Get in touch
          </span>
          <h1 className="mt-4 font-display text-4xl font-bold leading-tight">
            Let's talk <span className="text-gradient-gold">intelligence</span>.
          </h1>
          <p className="mt-4 text-white/55">
            Tell us about your operation and we'll set you up with enterprise access, custom
            dashboards and API keys. Our team typically replies within one business day.
          </p>
          <div className="mt-8 space-y-3">
            {[
              ['Enterprise analytics & API tiers', '✓'],
              ['Wallet clustering & whale tracking', '✓'],
              ['White-label & SLA options', '✓'],
            ].map(([t]) => (
              <div key={t} className="flex items-center gap-2 text-sm text-white/70">
                <CheckCircle2 size={16} className="text-mint-400" /> {t}
              </div>
            ))}
          </div>
          <div className="mt-8 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/4 px-4 py-3 text-sm">
            <Mail size={16} className="text-gold-400" />
            <span className="text-white/70">sales@wcoin.casino</span>
          </div>
        </div>

        <Card className="p-7">
          {sent ? (
            <div className="flex h-full flex-col items-center justify-center py-10 text-center">
              <CheckCircle2 size={48} className="text-mint-400" />
              <h2 className="mt-4 font-display text-2xl font-bold">Request received</h2>
              <p className="mt-2 text-white/55">Thanks — our team will reach out shortly.</p>
              <Link
                to="/app"
                className="mt-6 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110"
              >
                Explore the demo meanwhile →
              </Link>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                setSent(true)
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name" placeholder="Jordan" />
                <Field label="Last name" placeholder="Lee" />
              </div>
              <Field label="Work email" type="email" placeholder="you@casino.com" />
              <Field label="Company" placeholder="Your casino / studio" />
              <div>
                <label className="mb-1 block text-[13px] text-white/55">What are you looking for?</label>
                <select className="w-full rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm focus:border-gold-500/40 focus:outline-none">
                  <option className="bg-ink-800">Competitor analytics</option>
                  <option className="bg-ink-800">On-chain / whale tracking</option>
                  <option className="bg-ink-800">Streamer monitoring</option>
                  <option className="bg-ink-800">API & data integration</option>
                  <option className="bg-ink-800">Something else</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[13px] text-white/55">Message</label>
                <textarea
                  rows={3}
                  placeholder="Tell us a bit about your needs…"
                  className="w-full resize-none rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110"
              >
                Request enterprise access
              </button>
            </form>
          )}
        </Card>
      </div>
    </div>
  )
}

function Field({
  label,
  type = 'text',
  placeholder,
}: {
  label: string
  type?: string
  placeholder?: string
}) {
  return (
    <div>
      <label className="mb-1 block text-[13px] text-white/55">{label}</label>
      <input
        type={type}
        placeholder={placeholder}
        className="w-full rounded-xl border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm placeholder:text-white/30 focus:border-gold-500/40 focus:outline-none"
      />
    </div>
  )
}
