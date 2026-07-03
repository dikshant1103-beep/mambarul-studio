import { Component, ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props { children: ReactNode; label?: string }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary]', this.props.label, error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-8 rounded-xl bg-red-500/5 border border-red-500/20 text-center">
        <AlertTriangle size={28} className="text-red-400" />
        <div>
          <p className="text-sm font-semibold text-red-400">
            {this.props.label ?? 'Something went wrong'}
          </p>
          <p className="text-xs text-text-muted mt-1 font-mono">
            {this.state.error.message}
          </p>
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-500/30 text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
        >
          <RefreshCw size={11} /> Retry
        </button>
      </div>
    )
  }
}
