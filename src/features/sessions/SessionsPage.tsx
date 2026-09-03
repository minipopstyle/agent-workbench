import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import {
  ArrowRight,
  ChevronRight,
  FolderGit2,
  GitCompareArrows,
  Globe,
  Layers,
  LayoutGrid,
  List,
  Radio,
  Search,
  Sparkles,
  Terminal,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, sessionTitle, type RunSource, type Session, type SourceInfo } from '@/api'
import { buildComparePath } from '@/features/compare/compare-route'
import { SPRING_PRESS, SPRING_LAYOUT } from '@/lib/ease'
import { TiltCard } from '@/components/motion/tilt-card'

const timeFormat = (value: string) => {
  try {
    const d = new Date(value)
    const now = new Date()
    const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000)
    if (diffMin < 1) return '刚刚'
    if (diffMin < 60) return `${diffMin}分钟前`
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}小时前`
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
  } catch {
    return value
  }
}

const sourceLabels: Record<RunSource, string> = {
  codex: 'Codex',
  workbuddy: 'WorkBuddy',
  claude: 'Claude',
  import: 'Imported',
}

const sourceIcons: Record<RunSource, typeof Terminal> = {
  codex: Terminal,
  workbuddy: Users,
  claude: Zap,
  import: Globe,
}

const projectLabel = (session: Session) => session.projectName || session.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) || '未关联项目'

export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [query, setQuery] = useState('')
  const [selectedSource, setSelectedSource] = useState<'all' | RunSource>('all')
  const [filterType, setFilterType] = useState<'all' | 'live' | 'subagents'>('all')
  const [groupBy, setGroupBy] = useState<'source' | 'project'>('source')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [baseline, setBaseline] = useState<{ id: string; source: RunSource } | null>(null)
  const [candidate, setCandidate] = useState<{ id: string; source: RunSource } | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table')
  const navigate = useNavigate()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sessionsData, sourcesData] = await Promise.all([
        api.sessions(query, selectedSource === 'all' ? undefined : selectedSource),
        api.sources().catch(() => []),
      ])
      setSessions(sessionsData)
      setSources(sourcesData)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取本地 Session')
    } finally {
      setLoading(false)
    }
  }, [query, selectedSource])

  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 150)
    return () => clearTimeout(timer)
  }, [load])

  const stats = useMemo(() => {
    const total = sessions.length
    const liveCount = sessions.filter(s => s.status === 'live').length
    const subagents = sessions.reduce((acc, s) => acc + (s.childCount || 0), 0)
    const projects = new Set(sessions.map(s => s.projectPath).filter(Boolean)).size
    const bySource = {
      codex: sessions.filter(s => s.source === 'codex').length,
      workbuddy: sessions.filter(s => s.source === 'workbuddy').length,
      claude: sessions.filter(s => s.source === 'claude').length,
      import: sessions.filter(s => s.source === 'import').length,
    }
    return { total, liveCount, subagents, projects, bySource }
  }, [sessions])

  const readySourcesCount = useMemo(() => {
    return sources.filter(s => s.status === 'ready').length || (sessions.length ? 1 : 0)
  }, [sources, sessions])

  const filteredSessions = useMemo(() => {
    return sessions.filter(s => {
      if (selectedSource !== 'all' && s.source !== selectedSource) return false
      if (filterType === 'live') return s.status === 'live'
      if (filterType === 'subagents') return (s.childCount || 0) > 0
      return true
    }).toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }, [sessions, selectedSource, filterType])

  const groups = useMemo(() => {
    if (groupBy === 'source') {
      const grouped: Record<string, { label: string; icon: typeof Terminal; source: RunSource; items: Session[] }> = {}
      const order: RunSource[] = ['codex', 'workbuddy', 'claude', 'import']
      for (const src of order) {
        const items = filteredSessions.filter(s => s.source === src)
        if (items.length > 0 || (selectedSource === src && filteredSessions.length > 0)) {
          grouped[src] = {
            label: `${sourceLabels[src]} 客户端会话`,
            icon: sourceIcons[src],
            source: src,
            items,
          }
        }
      }
      return grouped
    } else {
      const grouped: Record<string, { label: string; icon: typeof FolderGit2; source: RunSource | null; items: Session[] }> = {}
      for (const session of filteredSessions) {
        const key = session.projectPath || '未关联目录'
        if (!grouped[key]) {
          grouped[key] = { label: key, icon: FolderGit2, source: null, items: [] }
        }
        grouped[key].items.push(session)
      }
      return grouped
    }
  }, [filteredSessions, groupBy, selectedSource])

  const openCompare = () => {
    if (baseline && candidate) {
      navigate(buildComparePath(baseline, candidate))
    }
  }

  const toggleSelect = (side: 'a' | 'b', session: Session) => {
    if (side === 'a') {
      setBaseline(prev => (prev?.id === session.id ? null : { id: session.id, source: session.source }))
    } else {
      setCandidate(prev => (prev?.id === session.id ? null : { id: session.id, source: session.source }))
    }
  }

  return (
    <main className="aw-page">
      {/* 头部：多源就绪展示 */}
      <section className="aw-page-header">
        <div className="aw-page-title-group">
          <h2>Sessions</h2>
          <span className="aw-counter-badge">{stats.total} total</span>
        </div>
        <div className="aw-badge-ready" title="已激活多 Agent 本地适配引擎">
          <span></span> {readySourcesCount} Sources Ready
        </div>
      </section>

      {/* 紧致数据横条 */}
      <section className="aw-compact-stats">
        <div className="aw-compact-stat">
          <span>全部会话</span>
          <b>{stats.total}</b>
        </div>
        <div className="aw-compact-stat">
          <span className={stats.liveCount ? 'dot-live' : ''}></span>
          <span>实时监听</span>
          <b>{stats.liveCount}</b>
        </div>
        <div className="aw-compact-stat">
          <span>Codex</span>
          <b style={{ color: '#2563eb' }}>{stats.bySource.codex}</b>
        </div>
        <div className="aw-compact-stat">
          <span>WorkBuddy</span>
          <b style={{ color: '#7e22ce' }}>{stats.bySource.workbuddy}</b>
        </div>
        <div className="aw-compact-stat">
          <span>Claude</span>
          <b style={{ color: '#c2410c' }}>{stats.bySource.claude}</b>
        </div>
        <div className="aw-compact-stat">
          <span>关联项目</span>
          <b>{stats.projects}</b>
        </div>
      </section>

      {/* 筛选与分组工具栏 */}
      <section className="aw-filter-bar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="aw-filter-left" style={{ flexWrap: 'wrap', gap: 8 }}>
          {/* 搜索框 */}
          <div className="aw-input-search">
            <Search size={14} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索标题、模型、项目或 ID…"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} style={{ border: 0, background: 'none', color: '#94a3b8' }}>
                <X size={13} />
              </button>
            )}
          </div>

          {/* 数据源快捷 Filter Tabs */}
          <div className="aw-seg-tabs">
            <button
              type="button"
              className={`aw-seg-tab ${selectedSource === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedSource('all')}
            >
              全部源
            </button>
            <button
              type="button"
              className={`aw-seg-tab ${selectedSource === 'codex' ? 'active' : ''}`}
              onClick={() => setSelectedSource('codex')}
            >
              Codex ({stats.bySource.codex})
            </button>
            <button
              type="button"
              className={`aw-seg-tab ${selectedSource === 'workbuddy' ? 'active' : ''}`}
              onClick={() => setSelectedSource('workbuddy')}
            >
              WorkBuddy ({stats.bySource.workbuddy})
            </button>
            <button
              type="button"
              className={`aw-seg-tab ${selectedSource === 'claude' ? 'active' : ''}`}
              onClick={() => setSelectedSource('claude')}
            >
              Claude ({stats.bySource.claude})
            </button>
          </div>

          {/* 状态过滤 Tabs */}
          <div className="aw-seg-tabs">
            <button
              type="button"
              className={`aw-seg-tab ${filterType === 'all' ? 'active' : ''}`}
              onClick={() => setFilterType('all')}
            >
              全部状态
            </button>
            <button
              type="button"
              className={`aw-seg-tab ${filterType === 'live' ? 'active' : ''}`}
              onClick={() => setFilterType('live')}
            >
              {stats.liveCount > 0 && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#16a34a' }}></span>}
              实时 ({stats.liveCount})
            </button>
            <button
              type="button"
              className={`aw-seg-tab ${filterType === 'subagents' ? 'active' : ''}`}
              onClick={() => setFilterType('subagents')}
            >
              含子 Agent
            </button>
          </div>

          {/* 分组维度切换 */}
          <div className="aw-seg-tabs" title="切换分组聚合方式">
            <button
              type="button"
              className={`aw-seg-tab ${groupBy === 'source' ? 'active' : ''}`}
              onClick={() => setGroupBy('source')}
            >
              <Users size={12} /> 按客户端
            </button>
            <button
              type="button"
              className={`aw-seg-tab ${groupBy === 'project' ? 'active' : ''}`}
              onClick={() => setGroupBy('project')}
            >
              <Layers size={12} /> 按项目
            </button>
          </div>

          {/* 视图模式 */}
          <div className="aw-seg-tabs">
            <button
              type="button"
              className={`aw-seg-tab ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              aria-label="列表模式"
            >
              <List size={13} />
            </button>
            <button
              type="button"
              className={`aw-seg-tab ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              aria-label="网格模式"
            >
              <LayoutGrid size={13} />
            </button>
          </div>
        </div>

        <div className="aw-filter-right">
          <span className={`aw-slot-pill a ${baseline ? 'set' : ''}`}>
            A: {baseline ? `${sourceLabels[baseline.source]}:${baseline.id.slice(0, 6)}` : '未选'}
          </span>
          <span className={`aw-slot-pill b ${candidate ? 'set' : ''}`}>
            B: {candidate ? `${sourceLabels[candidate.source]}:${candidate.id.slice(0, 6)}` : '未选'}
          </span>
          <motion.button
            whileTap={SPRING_PRESS}
            type="button"
            className="aw-btn-compare"
            disabled={!baseline || !candidate || baseline.id === candidate.id}
            onClick={openCompare}
          >
            <GitCompareArrows size={13} /> 对比
          </motion.button>
        </div>
      </section>

      {/* 异常提示 */}
      {error && (
        <div className="aw-inline-error">
          <b>读取失败：</b>{error}
        </div>
      )}

      {/* 列表主体 */}
      {loading && !sessions.length ? (
        <section className="aw-empty">
          <Radio className="aw-spin" size={20} color="#2563eb" />
          <b>正在索引本地多 Agent 会话…</b>
          <p>正在扫描 Codex、WorkBuddy、Claude 本地会话数据</p>
        </section>
      ) : !filteredSessions.length ? (
        <section className="aw-empty">
          <Sparkles size={20} color="#94a3b8" />
          <b>未找到匹配的会话</b>
          <p>请尝试清除搜索关键词或切换数据源过滤条件</p>
        </section>
      ) : (
        <div className="aw-session-tree">
          {Object.entries(groups).map(([groupKey, groupData]) => {
            const GroupIcon = groupData.icon
            const items = groupData.items
            return (
              <motion.details
                layout
                transition={SPRING_LAYOUT}
                key={groupKey}
                className="aw-tree-group"
                open={true}
              >
                <summary className="aw-tree-header">
                  <div className="aw-tree-dir">
                    <ChevronRight className="aw-tree-chevron" size={13} />
                    <GroupIcon size={14} color={groupData.source === 'workbuddy' ? '#7e22ce' : groupData.source === 'claude' ? '#c2410c' : '#2563eb'} />
                    <span style={{ fontWeight: 600 }}>{groupData.label}</span>
                  </div>
                  <span className="aw-tree-count">{items.length} 个会话</span>
                </summary>

                {viewMode === 'table' ? (
                  <div className="aw-tree-items">
                    {items.map(session => {
                      const isLive = session.status === 'live'
                      return (
                        <div key={`${session.source}-${session.id}`} className="aw-tree-row">
                          <div className="aw-session-list-title" title={sessionTitle(session)}>
                            {sessionTitle(session)}
                          </div>

                          <div className="aw-session-list-identity" title={session.id}>
                            <span className={`aw-tag-source ${session.source}`}>
                              {sourceLabels[session.source] || session.source}
                            </span>
                            <b>{session.id.slice(0, 8)}</b>
                            {isLive && (
                              <span className="aw-pill-status live">
                                <Radio size={10} className="aw-spin" /> Live
                              </span>
                            )}
                          </div>

                          <div className="aw-session-list-model" title={session.additionalModelCount ? `${session.model || 'Default'}，另有 ${session.additionalModelCount} 个模型` : session.model || 'Default'}>
                            <span className="aw-tag-model">{session.model || 'Default'}</span>
                            {session.additionalModelCount ? <span className="aw-model-more">+{session.additionalModelCount}</span> : null}
                          </div>

                          <div className="aw-session-list-project" title={session.projectPath || projectLabel(session)}>
                            {projectLabel(session)}
                          </div>

                          <time className="aw-session-list-time">
                            {timeFormat(session.updatedAt)}
                          </time>

                          <div className="aw-row-ctrls">
                            <button
                              type="button"
                              title="设为 Baseline A"
                              className={`aw-btn-pick-pill a ${baseline?.id === session.id ? 'active' : ''}`}
                              onClick={() => toggleSelect('a', session)}
                            >
                              A
                            </button>
                            <button
                              type="button"
                              title="设为 Candidate B"
                              className={`aw-btn-pick-pill b ${candidate?.id === session.id ? 'active' : ''}`}
                              onClick={() => toggleSelect('b', session)}
                            >
                              B
                            </button>
                            <button
                              type="button"
                              className="aw-btn-view"
                              onClick={() => navigate(`/sessions/${session.id}/runs?source=${session.source}`)}
                            >
                              分析 <ArrowRight size={11} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="aw-grid-view">
                    {items.map(session => {
                      const isLive = session.status === 'live'
                      return (
                        <TiltCard key={`${session.source}-${session.id}`} className="aw-card-compact">
                          <div className="aw-session-card-main">
                            <div className="aw-session-card-title" title={sessionTitle(session)}>
                              {sessionTitle(session)}
                            </div>
                            <div className="aw-session-card-identity" title={session.id}>
                                <span className={`aw-tag-source ${session.source}`}>
                                  {sourceLabels[session.source] || session.source}
                                </span>
                                <b>
                                  {session.id.slice(0, 8)}
                                </b>
                              {isLive ? (
                                <span className="aw-pill-status live">
                                  <Radio size={10} className="aw-spin" /> Live
                                </span>
                              ) : null}
                            </div>
                            <div className="aw-session-card-models">
                              <span className="aw-tag-model">{session.model || 'Default'}</span>
                              {session.additionalModelCount ? <span className="aw-model-more">+{session.additionalModelCount}</span> : null}
                            </div>
                            <div className="aw-session-card-project" title={session.projectPath || projectLabel(session)}>
                              <FolderGit2 size={12} /> {projectLabel(session)}
                            </div>
                          </div>

                          <div className="aw-card-compact-foot">
                            <time>{timeFormat(session.updatedAt)}</time>
                            <div className="aw-row-ctrls">
                              <button
                                type="button"
                                className={`aw-btn-pick-pill a ${baseline?.id === session.id ? 'active' : ''}`}
                                onClick={() => toggleSelect('a', session)}
                              >
                                A
                              </button>
                              <button
                                type="button"
                                className={`aw-btn-pick-pill b ${candidate?.id === session.id ? 'active' : ''}`}
                                onClick={() => toggleSelect('b', session)}
                              >
                                B
                              </button>
                              <button
                                type="button"
                                className="aw-btn-view"
                                onClick={() => navigate(`/sessions/${session.id}/runs?source=${session.source}`)}
                              >
                                分析 <ArrowRight size={11} />
                              </button>
                            </div>
                          </div>
                        </TiltCard>
                      )
                    })}
                  </div>
                )}
              </motion.details>
            )
          })}
        </div>
      )}
    </main>
  )
}
