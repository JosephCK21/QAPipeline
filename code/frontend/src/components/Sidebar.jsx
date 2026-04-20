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
    <aside className={`fixed left-0 top-0 h-full bg-white border-r border-[#DFE1E6] transition-all duration-300 z-40 ${
      sidebarCollapsed ? 'w-16' : 'w-64'
    }`}>
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-[#DFE1E6]">
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-[#0C66E4] to-[#0747A6] rounded-lg flex items-center justify-center shadow-sm">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-[#172B4D] tracking-tight">QA Pipeline</span>
          </div>
        )}
        {sidebarCollapsed && (
          <div className="w-8 h-8 bg-gradient-to-br from-[#0C66E4] to-[#0747A6] rounded-lg flex items-center justify-center mx-auto shadow-sm">
            <Zap className="w-5 h-5 text-white" />
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="p-3 space-y-1">
        {navItems.map((item, index) => {
          const Icon = item.icon;
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);

          return (
            <Link
              key={index}
              to={item.path}
              className={`relative flex items-center gap-3 px-3 py-2.5 rounded-md transition-all duration-150 group ${
                isActive
                  ? 'bg-[#E9F2FF] text-[#0747A6] font-medium'
                  : 'text-[#44546F] hover:bg-[#F1F2F4] hover:text-[#172B4D]'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-[#0C66E4] rounded-r-full" />
              )}
              <Icon className={`w-[18px] h-[18px] flex-shrink-0 ${isActive ? 'text-[#0C66E4]' : 'text-[#5E6C84] group-hover:text-[#172B4D]'}`} />
              {!sidebarCollapsed && (
                <>
                  <span className="flex-1 text-sm truncate">{item.label}</span>
                  {item.badge > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-[#0C66E4] text-white rounded-full min-w-[18px] text-center">
                      {item.badge}
                    </span>
                  )}
                </>
              )}
              {sidebarCollapsed && item.badge > 0 && (
                <span className="absolute right-1 top-1 px-1.5 py-0.5 text-[10px] font-bold bg-[#0C66E4] text-white rounded-full">
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
        className="absolute bottom-4 right-0 transform translate-x-1/2 w-6 h-6 bg-white border border-[#C1C7D0] rounded-full flex items-center justify-center text-[#5E6C84] hover:text-[#0C66E4] hover:border-[#0C66E4] hover:shadow-sm transition-all duration-150"
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
      </button>

      {/* Immutable Boundary Notice */}
      {!sidebarCollapsed && (
        <div className="absolute bottom-16 left-3 right-3 p-3 bg-[#E3FCEF] rounded-md border border-[#ABF5D1]">
          <div className="flex items-center gap-2 text-xs text-[#006644] font-medium">
            <div className="w-1.5 h-1.5 bg-[#00875A] rounded-full animate-pulse" />
            <span>Immutable Boundary Active</span>
          </div>
          <p className="text-[11px] text-[#006644]/80 mt-1 leading-relaxed">AI write access: test assets only</p>
        </div>
      )}
    </aside>
  );
}

export default Sidebar;
