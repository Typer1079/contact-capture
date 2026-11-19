import { Component, type ReactNode } from 'react'
import { isLoadError, reloadForUpdate } from '../lib/freshLoad'

interface Props {
  children: ReactNode
  onHome?: () => void
}
interface State {
  error: Error | null
}

/** Shows a message with Reload / Home buttons instead of a blank white screen if something breaks. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[app error]', error)
    // A newer version was published while the app was open: load it.
    if (isLoadError(error)) reloadForUpdate()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const update = isLoadError(error)
    return (
      <div role="alert" className="card mx-auto mt-6 max-w-md space-y-3 text-center">
        <h2 className="text-lg font-semibold text-slate-900">{update ? 'Couldn’t load this screen' : 'Something went wrong'}</h2>
        <p className="text-sm text-slate-600">
          {update
            ? 'Check that you have a signal, then tap Reload. (This also picks up a newer version if one was just published.)'
            : 'This screen hit a problem. Your saved contacts are safe. Tap Reload to try again.'}
        </p>
        <p className="break-words rounded-lg bg-slate-100 px-3 py-2 text-left font-mono text-xs text-slate-500">{error.message || String(error)}</p>
        <div className="flex gap-2">
          {this.props.onHome && (
            <button type="button" className="btn-secondary flex-1" onClick={() => { this.setState({ error: null }); this.props.onHome?.() }}>
              Home
            </button>
          )}
          <button type="button" className="btn-primary flex-1" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
