import { type CSSProperties } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Activity, ArrowLeft, Database, GitCompareArrows, Home, Search, Settings2 } from 'lucide-react'
import {
  AnimatedSidebar, AnimatedSidebarContent, AnimatedSidebarFooter, AnimatedSidebarGroup, AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel, AnimatedSidebarHeader, AnimatedSidebarInset, AnimatedSidebarMenu, AnimatedSidebarMenuButton, AnimatedSidebarMenuItem,
  AnimatedSidebarProvider, AnimatedSidebarRail, AnimatedSidebarTrigger,
} from '@/components/motion/animated-sidebar'

const isRoute = (path: string, current: string) => path === '/' ? current === '/' : current.startsWith(path)

export function WorkbenchShell() {
  const { pathname, search } = useLocation(); const navigate = useNavigate()
  const section = pathname.startsWith('/sources') ? 'Configuration' : 'Workspace'
  const liveView = pathname === '/live' || pathname.endsWith('/live')
  const liveSource = (['codex', 'workbuddy', 'claude'].includes(new URLSearchParams(search).get('source') || '') ? new URLSearchParams(search).get('source') : 'codex') as 'codex' | 'workbuddy' | 'claude'

  return <AnimatedSidebarProvider style={{ '--sidebar-width': '190px', '--sidebar-width-mobile': '280px' } as CSSProperties}>
    <div className="aw-shell">
      <AnimatedSidebar ariaLabel="Agent Workbench navigation" collapsible="icon" panelClassName="aw-sidebar">
        <AnimatedSidebarHeader className="aw-sidebar-header">
          <div className="aw-workspace">
            <AnimatedSidebarTrigger className="aw-mark" aria-label="Toggle sidebar"><img src="/logo.jpg" alt="" className="aw-mark-img" /></AnimatedSidebarTrigger>
            <button type="button" className="aw-workspace-title" onClick={() => navigate('/')}>
              <b>Agent Workbench</b>
            </button>
          </div>
        </AnimatedSidebarHeader>
        <AnimatedSidebarContent className="aw-sidebar-content">
          <AnimatedSidebarGroup>
            <AnimatedSidebarGroupLabel>Workspace</AnimatedSidebarGroupLabel>
            <AnimatedSidebarGroupContent>
              <AnimatedSidebarMenu>
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<Home size={18} />}
                    isActive={pathname === '/' || (pathname.startsWith('/sessions') && !pathname.includes('/live'))}
                    onSelect={() => navigate('/')}
                  >
                    Home
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<Activity size={18} />}
                    isActive={pathname.startsWith('/live') || pathname.includes('/live')}
                    onSelect={() => navigate('/live')}
                  >
                    Activity
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<GitCompareArrows size={18} />}
                    isActive={isRoute('/compare', pathname)}
                    onSelect={() => navigate('/compare')}
                  >
                    Trace Compare
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              </AnimatedSidebarMenu>
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>

          <AnimatedSidebarGroup>
            <AnimatedSidebarGroupLabel>Configuration</AnimatedSidebarGroupLabel>
            <AnimatedSidebarGroupContent>
              <AnimatedSidebarMenu>
                <AnimatedSidebarMenuItem>
                  <AnimatedSidebarMenuButton
                    icon={<Database size={18} />}
                    isActive={isRoute('/sources', pathname)}
                    onSelect={() => navigate('/sources')}
                  >
                    Sources
                  </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
              </AnimatedSidebarMenu>
            </AnimatedSidebarGroupContent>
          </AnimatedSidebarGroup>
        </AnimatedSidebarContent>
        <AnimatedSidebarFooter className="aw-sidebar-footer"><div className="aw-local-state"><span></span><div><b>Local-only mode</b><small>No external sync</small></div></div></AnimatedSidebarFooter>
        <AnimatedSidebarRail />
      </AnimatedSidebar>
      <AnimatedSidebarInset className="aw-inset">
        <header className="aw-topbar">
          {pathname.startsWith('/sessions/') && <button type="button" className="aw-topbar-back" onClick={() => navigate('/')} aria-label="返回"><ArrowLeft size={16} /></button>}
          {liveView ? <div className="aw-topbar-live-switch"><select aria-label="Activity 客户端" value={liveSource} onChange={event => navigate(`/live?source=${event.target.value}`)}><option value="codex">Codex</option><option value="workbuddy">WorkBuddy</option><option value="claude">Claude</option></select></div> : <span className="aw-topbar-section">{section}</span>}
          <div className="aw-top-actions">
            <button type="button" className="aw-icon-button" aria-label="Search"><Search size={16} /></button>
            <Link to="/sources" className="aw-icon-button" aria-label="Settings"><Settings2 size={16} /></Link>
          </div>
        </header>
        <Outlet />
      </AnimatedSidebarInset>
    </div>
  </AnimatedSidebarProvider>
}
