/** Catches a settings-surface render failure instead of leaving the content pane blank. */
import * as React from 'react'
import { h, M, T } from './ampUi.js'

interface BoundaryProps {
  readonly surface: string
  readonly children: React.ReactNode
}

interface BoundaryState {
  readonly error: Error | null
}

const REPORT_ROUTE = '/deepseek-coordination/amp/client-report'

export class AmpRenderBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      void fetch(REPORT_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          surface: this.props.surface,
          message: error.message,
          stack: error.stack ?? '',
          componentStack: info.componentStack ?? '',
        }),
      }).catch(() => undefined)
    } catch {
      // Reporting must never mask the original failure.
    }
  }

  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children
    return h(
      M.Box,
      { sx: { py: 2 } },
      h(
        M.Alert,
        { severity: 'error', variant: 'outlined', sx: { borderRadius: T.radius, alignItems: 'flex-start' } },
        h(M.Typography, { variant: 'subtitle2', sx: { fontWeight: 700, mb: 0.5 } }, '设置页渲染失败'),
        h(M.Typography, { variant: 'caption', sx: { display: 'block', color: T.secondary, mb: 1 } },
          '错误已记录到 AMP 客户端报告。请把下面的信息发给维护者；刷新页面通常可恢复。'),
        h(
          M.Box,
          { component: 'pre', sx: { m: 0, p: 1, maxHeight: 180, overflow: 'auto', borderRadius: T.radiusSm, backgroundColor: T.raised, color: T.text, fontFamily: T.mono, fontSize: 10.5, whiteSpace: 'pre-wrap' } },
          `${this.state.error.message}\n\n${(this.state.error.stack ?? '').split('\n').slice(0, 4).join('\n')}`,
        ),
        h(M.Button, {
          size: 'small',
          onClick: () => { window.location.reload() },
          sx: { mt: 1, textTransform: 'none' },
        }, '刷新页面'),
      ),
    )
  }
}
