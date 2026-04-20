import React from 'react';
import { Bell, Search, User } from 'lucide-react';

function Navbar() {
  return (
    <header className="h-14 bg-white border-b border-[#DFE1E6] flex items-center justify-between pl-6 pr-6 sticky top-0 z-30">
      {/* Search bar — Jira-style */}
      <div className="flex-1 max-w-md">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#5E6C84]" />
          <input
            type="text"
            placeholder="Search..."
            className="w-full pl-9 pr-3 py-1.5 bg-[#F1F2F4] border border-transparent rounded-md text-sm text-[#172B4D] placeholder-[#8993A4] hover:bg-[#E9EAEE] focus:bg-white focus:border-[#0C66E4] focus:ring-1 focus:ring-[#0C66E4] transition-all outline-none"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          className="relative p-2 text-[#5E6C84] hover:text-[#172B4D] hover:bg-[#F1F2F4] rounded-md transition-colors"
          aria-label="Notifications"
        >
          <Bell className="w-[18px] h-[18px]" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[#C9372C] rounded-full ring-2 ring-white" />
        </button>

        {/* User Profile */}
        <div className="flex items-center gap-3 pl-3 ml-2 border-l border-[#DFE1E6]">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium text-[#172B4D] leading-tight">DevOps Admin</p>
            <p className="text-xs text-[#5E6C84] leading-tight">admin@company.com</p>
          </div>
          <div className="w-8 h-8 bg-gradient-to-br from-[#0C66E4] to-[#0747A6] rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm">
            <User className="w-[18px] h-[18px]" />
          </div>
        </div>
      </div>
    </header>
  );
}

export default Navbar;
