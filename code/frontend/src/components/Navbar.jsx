import React from 'react';
import { Bell, Search, User } from 'lucide-react';

function Navbar() {

  return (
    <>
      <header className="h-16 bg-[#1E1E2F] border-b border-[#282A36] flex items-center justify-between pl-0 pr-6 sticky top-0 z-30">
        <div className="flex-1"></div>

        {/* Actions */}
        <div className="flex items-center gap-4">
          {/* Notifications */}
          <button className="relative p-2 text-[#6272A4] hover:text-[#F8F8F2] hover:bg-[#282A36] rounded-lg transition-colors">
            <Bell className="w-5 h-5" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-[#FF5555] rounded-full" />
          </button>

          {/* User Profile */}
          <div className="flex items-center gap-3 pl-4 border-l border-[#282A36]">
            <div className="text-right">
              <p className="text-sm font-medium text-[#F8F8F2]">DevOps Admin</p>
              <p className="text-xs text-[#6272A4]">admin@company.com</p>
            </div>
            <div className="w-10 h-10 bg-gradient-to-br from-[#6272A4] to-[#8BE9FD] rounded-full flex items-center justify-center">
              <User className="w-5 h-5 text-white" />
            </div>
          </div>
        </div>
      </header>
    </>
  );
}

export default Navbar;