import { Component, ReactNode } from 'react'

// App-wide error boundary. Without it, a render-time throw anywhere (e.g. a chart
// fed a malformed payload during a backend freeze) unmounts the entire SPA to a
// blank white screen. This catches it and shows a recoverable fallback instead.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surface to the console (and, once wired, an error tracker like Sentry)
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid min-h-screen place-items-center bg-ink-950 px-6 text-center text-white">
        <div className="max-w-md">
          <div className="mb-3 text-4xl">⚠️</div>
          <h1 className="font-display text-xl font-bold">Something went wrong</h1>
          <p className="mt-2 text-sm text-white/55">
            The dashboard hit an unexpected error. This is usually transient — reloading fixes it.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-5 rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
