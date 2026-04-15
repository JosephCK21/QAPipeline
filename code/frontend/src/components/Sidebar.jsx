import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAppContext } from '../App';
import { 
  FolderKanban,
  Play, 
  ChevronLeft,
  ChevronRight,
  Zap
} from 'lucide-react';

function Sidebar() {
  const location = useLocation();
  const { sidebarCollapsed, setSidebarCollapsed, activeRuns } = useAppContext();

  const navItems = [
    { path: '/', icon: FolderKanban, label: 'Projects' },
    { path: '/pipelines', icon: Play, label: 'Pipeline Runs', badge: activeRuns.filter(r => r.status === 'Running').length },
    { path: '/llm-traces', icon: Zap, label: 'Agent Console' }
  ];

  return (
    <aside className={`fixed left-0 top-0 h-full bg-[#1E1E2F] border-r border-[#282A36] transition-all duration-300 z-40 ${
      sidebarCollapsed ? 'w-16' : 'w-64'
    }`}>
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-[#282A36]">
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-[#6272A4] to-[#50FA7B] rounded-lg flex items-center justify-center">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-[#F8F8F2]">QA Pipeline</span>
          </div>
        )}
        {sidebarCollapsed && (
          <div className="w-8 h-8 bg-gradient-to-br from-[#6272A4] to-[#50FA7B] rounded-lg flex items-center justify-center mx-auto">
            <Zap className="w-5 h-5 text-white" />
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="p-4 space-y-2">
        {navItems.map((item, index) => {
          const Icon = item.icon;
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);
          
          return (
            <Link
              key={index}
              to={item.path}
              className={`flex items-center gap-3 px-3 py-3 rounded-lg transition-all duration-200 group ${
                isActive 
                  ? 'bg-[#6272A4] text-white' 
                  : 'text-[#6272A4] hover:bg-[#282A36] hover:text-[#F8F8F2]'
              }`}
            >
              <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-white' : 'text-[#6272A4] group-hover:text-[#F8F8F2]'}`} />
              {!sidebarCollapsed && (
                <>
                  <span className="flex-1 text-sm font-medium truncate">{item.label}</span>
                  {item.badge > 0 && (
                    <span className="px-2 py-0.5 text-xs font-bold bg-[#50FA7B] text-[#1E1E2F] rounded-full">
                      {item.badge}
                    </span>
                  )}
                </>
              )}
              {sidebarCollapsed && item.badge > 0 && (
                <span className="absolute left-10 px-1.5 py-0.5 text-xs font-bold bg-[#50FA7B] text-[#1E1E2F] rounded-full">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Collapse Toggle */}
      <button
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        className="absolute bottom-4 right-0 transform translate-x-1/2 w-6 h-6 bg-[#282A36] border border-[#6272A4] rounded-full flex items-center justify-center text-[#6272A4] hover:text-[#F8F8F2] hover:bg-[#6272A4] transition-all duration-200"
      >
        {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>

      {/* Immutable Boundary Notice */}
      {!sidebarCollapsed && (
        <div className="absolute bottom-16 left-4 right-4 p-3 bg-[#282A36] rounded-lg border border-[#6272A4]/30">
          <div className="flex items-center gap-2 text-xs text-[#6272A4]">
            <div className="w-2 h-2 bg-[#50FA7B] rounded-full animate-pulse" />
            <span>Immutable Boundary Active</span>
          </div>
          <p className="text-xs text-[#6272A4]/70 mt-1">AI write access: test assets only</p>
        </div>
      )}
    </aside>
  );
}

export default Sidebar;