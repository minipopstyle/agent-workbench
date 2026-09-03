import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { CheckCircle2, CircleAlert, FolderSearch, Globe, RefreshCw, ShieldCheck, Terminal, Users, Zap } from 'lucide-react'
import { api, type RunSource, type SourceInfo } from '@/api'
import { SPRING_PRESS } from '@/lib/ease'

const sourceIcons: Record<RunSource, typeof Terminal> = {
  codex: Terminal,
  workbuddy: Users,
  claude: Zap,
  import: Globe,
}

const sourceThemeColors: Record<RunSource, { bg: string; border: string; text: string; iconBg: string }> = {
  codex: { bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8', iconBg: '#dbeafe' },
  workbuddy: { bg: '#faf5ff', border: '#e9d5ff', text: '#7e22ce', iconBg: '#f3e8ff' },
  claude: { bg: '#fff7ed', border: '#ffedd5', text: '#c2410c', iconBg: '#ffedd5' },
  import: { bg: '#f8fafc', border: '#e2e8f0', text: '#475569', iconBg: '#f1f5f9' },
}

export function SourcesPage() {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchSources = () => {
    setLoading(true)
    api.sources()
      .then(val => {
        setSources(val)
        setError('')
      })
      .catch((err) => setError(err instanceof Error ? err.message : '无法连接本地服务 127.0.0.1:47832'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchSources()
  }, [])

  return (
    <main className="aw-page">
      <section className="aw-page-header">
        <div className="aw-page-title-group">
          <h2>Data Sources & Privacy</h2>
          <span className="aw-counter-badge">{sources.filter(s => s.status === 'ready').length} / {sources.length} active</span>
        </div>
        <motion.button
          whileTap={SPRING_PRESS}
          type="button"
          className="aw-btn-compare"
          onClick={fetchSources}
          disabled={loading}
        >
          <RefreshCw size={12} className={loading ? 'aw-spin' : ''} /> 重新检测
        </motion.button>
      </section>

      {error && <div className="aw-inline-error"><b>连接异常：</b>{error}</div>}

      <div className="aw-source-grid">
        {sources.map(src => {
          const Icon = sourceIcons[src.id] || FolderSearch
          const theme = sourceThemeColors[src.id] || sourceThemeColors.import
          const isReady = src.status === 'ready'
          return (
            <article key={src.id} className="aw-source-card">
              <div className="aw-source-card-main">
                <div className="aw-source-icon" style={{ background: theme.iconBg, color: theme.text }}>
                  <Icon size={18} />
                </div>
                <div className="aw-source-card-text">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <h3>{src.label} 本地会话</h3>
                    {isReady ? (
                      <span className="aw-pill-status live">
                        <CheckCircle2 size={10} /> 就绪 ({src.sessionCount} 会话)
                      </span>
                    ) : (
                      <span className="aw-pill-status complete" style={{ color: '#94a3b8' }}>
                        未探测到日志
                      </span>
                    )}
                  </div>
                  <p title={src.path || src.root}>{src.path || src.root}</p>
                </div>
              </div>
              <div>
                <span className="aw-tag-model" style={{ fontSize: 10.5 }}>
                  只读索引 · 本地直接接入
                </span>
              </div>
            </article>
          )
        })}

        {!sources.length && !loading && (
          <article className="aw-source-card">
            <div className="aw-source-card-main">
              <div className="aw-source-icon" style={{ background: '#fef2f2', color: '#b91c1c' }}>
                <CircleAlert size={18} />
              </div>
              <div className="aw-source-card-text">
                <h3>未检测到任何本地 Agent 数据源</h3>
                <p>请确认 Codex、WorkBuddy 或 Claude 日志目录存在。</p>
              </div>
            </div>
          </article>
        )}
      </div>

      {/* 隐私与安全规范面板 */}
      <section className="aw-privacy-panel">
        <div className="aw-privacy-icon">
          <ShieldCheck size={18} />
        </div>
        <div>
          <b>本地运行安全与隐私保障</b>
          <p>
            Agent Workbench 专为深度轨迹分析设计，遵循严格的本机隔离与只读安全原则：
          </p>
          <ul>
            <li><b>127.0.0.1 严格绑定：</b>仅在本地回环地址运行，不对局域网或公网开放。</li>
            <li><b>0 遥测与 0 云端回传：</b>无外部埋点或数据收集，完全本机运行。</li>
            <li><b>只读日志解析：</b>流式只读日志文件，不注入、不修改、不干预任何 Agent 客户端进程。</li>
          </ul>
        </div>
      </section>
    </main>
  )
}
