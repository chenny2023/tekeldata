import { useState, FormEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { api } from '../data/api'

// Shared email-subscribe box (no login — double opt-in via the confirmation email).
// Replaces the old account/login flow: email is collected only here, at the point
// of subscribing to the daily report. `compact` renders a tighter sidebar variant.
export function Subscribe({
  cta = 'Get it daily',
  placeholder = 'you@email.com',
  compact = false,
}: {
  cta?: string
  placeholder?: string
  compact?: boolean
}) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!/.+@.+\..+/.test(email)) return
    setState('sending')
    try {
      await api.subscribe(email)
      setState('sent')
    } catch {
      setState('error')
    }
  }
  if (state === 'sent')
    return <p className={`text-mint-400 ${compact ? 'text-[12px]' : 'text-sm'}`}>✓ Check your inbox — confirm the link to start receiving the daily report.</p>
  return (
    <form onSubmit={submit} className={compact ? 'flex flex-col gap-2' : 'flex w-full max-w-md flex-col gap-2 sm:flex-row'}>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={placeholder}
        className={`flex-1 rounded-xl border border-white/12 bg-white/5 px-4 ${compact ? 'py-2 text-[13px]' : 'py-3 text-sm'} text-white placeholder:text-white/35 focus:border-gold-500/50 focus:outline-none`}
      />
      <button
        type="submit"
        disabled={state === 'sending'}
        className={`inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 ${compact ? 'px-4 py-2 text-[13px]' : 'px-5 py-3 text-sm'} font-semibold text-ink-950 hover:brightness-110 disabled:opacity-60`}
      >
        {state === 'sending' ? 'Sending…' : cta} <ArrowRight size={15} />
      </button>
    </form>
  )
}
