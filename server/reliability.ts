export function reliabilityMetrics(scores: number[]) {
  const n = scores.length; const c = scores.filter(score => score >= 70).length
  const choose = (top: number, bottom: number) => { if (bottom < 0 || bottom > top) return 0; let out = 1; for (let index = 1; index <= bottom; index++) out = out * (top - bottom + index) / index; return out }
  const passAt = (k: number) => k > n ? null : 1 - choose(n - c, k) / choose(n, k)
  const mean = n ? scores.reduce((sum, score) => sum + score, 0) / n : null
  return { evaluatedRuns: n, successes: c, successRate: n ? c / n : null, variance: n > 1 && mean != null ? scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / n : null, passAt: [1, 2, 3].map(k => ({ k, passAt: passAt(k), passPower: k > n || !n ? null : (c / n) ** k })) }
}
