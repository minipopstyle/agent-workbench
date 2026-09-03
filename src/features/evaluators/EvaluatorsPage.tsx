import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { api } from '@/api'

export function EvaluatorsPage() {
  const [data, setData] = useState<{ rubrics: any[]; judgeConfigured: boolean } | null>(null); const [error, setError] = useState('')
  useEffect(() => { api.evaluators().then(setData).catch(err => setError(err.message)) }, [])
  return <main className="aw-page"><section className="aw-page-header"><div className="aw-page-title-group"><h2>Evaluators</h2><span className="aw-counter-badge">local by default</span></div></section>{error && <div className="aw-inline-error">{error}</div>}<section className="aw-privacy-panel"><div className="aw-privacy-icon"><ShieldCheck size={17} /></div><div><b>Privacy contract</b><p>Deterministic and manual evaluation stay on this machine. LLM Judge is disabled until all three environment variables are configured and each payload is previewed and confirmed.</p><small>Judge configured: {data?.judgeConfigured ? 'Yes' : 'No'}</small></div></section><section className="aw-rubric-grid">{data?.rubrics.map(rubric => <article key={rubric.id} className="aw-task-card"><span className="aw-eyebrow">Rubric v{rubric.version}</span><h3>{rubric.id}</h3>{rubric.dimensions.map((dimension: any) => <div className="aw-rubric-row" key={dimension.id}><span>{dimension.label}</span><b>{dimension.weight}%</b></div>)}</article>)}</section></main>
}
