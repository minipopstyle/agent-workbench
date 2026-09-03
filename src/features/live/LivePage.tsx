import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { CircleAlert } from 'lucide-react'
import { api, type RunSource, type Snapshot } from '@/api'

export function LivePage() {
  const { id = '' } = useParams()
  const [searchParams] = useSearchParams()
  const requestedSource = searchParams.get('source')
  const source: RunSource = requestedSource === 'claude' || requestedSource === 'workbuddy' || requestedSource === 'import' ? requestedSource : 'codex'
  const frame = useRef<HTMLIFrameElement>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')

  const push = (value: Snapshot | null) => {
    if (!value) return
    frame.current?.contentWindow?.postMessage({ kind: 'trajectory-v2:snapshot', data: value.v2 }, window.location.origin)
    frame.current?.contentWindow?.postMessage({ kind: 'trajectory-v2:theme', mode: 'light' }, window.location.origin)
  }

  useEffect(() => {
    let stream: EventSource | null = null
    api.snapshot(id, source).then(value => {
      setSnapshot(value)
      setError('')
      setTimeout(() => push(value), 0)
    }).catch(err => setError(err instanceof Error ? err.message : '读取 Session 失败'))

    stream = new EventSource(`/api/sessions/${source}/${id}/stream`)
    stream.addEventListener('snapshot', event => {
      try {
        const value = JSON.parse(event.data) as Snapshot
        setSnapshot(value)
        setError('')
        push(value)
      } catch {}
    })
    stream.addEventListener('diagnostic', event => {
      try { setError(JSON.parse(event.data).message) } catch {}
    })

    return () => {
      stream?.close()
    }
  }, [id, source])

  return (
    <main className="aw-live">
      {error && <div className="aw-inline-error"><CircleAlert size={15} />{error}</div>}
      <div className="aw-v2-frame">
        <iframe ref={frame} src="/legacy-v2/index.html" title="Trajectory V2" onLoad={() => push(snapshot)} />
      </div>
    </main>
  )
}
