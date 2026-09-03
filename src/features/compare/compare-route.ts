type SessionRef = { id: string; source: string }

export function buildComparePath(baseline: SessionRef, candidate: SessionRef) {
  const params = new URLSearchParams({
    baselineSource: baseline.source,
    baselineSession: baseline.id,
    candidateSource: candidate.source,
    candidateSession: candidate.id,
  })
  return `/compare?${params}`
}
