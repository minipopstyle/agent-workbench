import * as React from 'react'

type SessionArcDiagramProps = {
  leftSession: { id: string }
  rightSession: { id: string }
  conclusion: string
  deltaFocus: string
  deltaSummary: string
}

const shortId = (id: string) => id.slice(0, 8)
const summaryLines = (value: string) => {
  const summary = value.replace(/\s+/g, ' ').trim() || 'MEASURED TRACE DIFFERENCE'
  const chars = Array.from(summary)
  return chars.length <= 52 ? [summary] : [chars.slice(0, 52).join(''), `${chars.slice(52, 104).join('')}…`]
}

export function SessionArcDiagram({ leftSession, rightSession, conclusion, deltaFocus, deltaSummary }: SessionArcDiagramProps) {
  void React
  const lines = summaryLines(deltaSummary)
  return (
    <svg
      className="hero-arc session-arc-diagram"
      viewBox="0 0 520 300"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${deltaFocus}: ${conclusion}${conclusion === 'INCONCLUSIVE' ? ' / INSUFFICIENT EVIDENCE' : ''}. A ${shortId(leftSession.id)} to B ${shortId(rightSession.id)}.`}
    >
      <text className="session-arc-summary" x="260" y="30" textAnchor="middle">
        {lines.map((line, index) => <tspan key={line} x="260" dy={index ? 13 : 0}>{line}</tspan>)}
      </text>

      <path className="session-arc-line session-arc-line-light" d="M46 224 Q118 112 190 224" />
      <path className="session-arc-line session-arc-line-mid" d="M46 224 Q166 54 320 224" />
      <path className="session-arc-line session-arc-line-main" d="M46 224 Q264 10 480 224" />
      <path className="session-arc-baseline" d="M46 224 H480" />

      <circle className="session-arc-anchor session-arc-anchor-primary" cx="46" cy="224" r="5" />
      <circle className="session-arc-anchor session-arc-anchor-focus" cx="190" cy="224" r="4" />
      <circle className="session-arc-anchor session-arc-anchor-conclusion" cx="320" cy="224" r="4" />
      <circle className="session-arc-anchor session-arc-anchor-primary" cx="480" cy="224" r="5" />

      <g className="session-arc-label session-arc-label-left">
        <text x="46" y="253">A · {shortId(leftSession.id)}</text>
        <text className="session-arc-label-note" x="46" y="269">SESSION</text>
      </g>
      <g className="session-arc-label session-arc-label-focus" textAnchor="middle">
        <text x="190" y="253">{deltaFocus}</text>
        <text className="session-arc-label-note" x="190" y="269">DIFFERENCE FOCUS</text>
      </g>
      <g className="session-arc-label session-arc-label-conclusion" textAnchor="middle">
        <text x="320" y="253">{conclusion}</text>
        <text className="session-arc-label-note" x="320" y="269">CONCLUSION</text>
      </g>
      <g className="session-arc-label session-arc-label-right" textAnchor="end">
        <text x="480" y="253">B · {shortId(rightSession.id)}</text>
        <text className="session-arc-label-note" x="480" y="269">SESSION</text>
      </g>
    </svg>
  )
}
