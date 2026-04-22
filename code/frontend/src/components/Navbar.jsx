import React from 'react';
import { Bell, Search, User, Moon, Sun } from 'lucide-react';
import { useAppContext } from '../App';

function Navbar() {
  const { darkMode, toggleDarkMode } = useAppContext();

  return (
    <header className={`h-14 ${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-white border-[#DFE1E6]'} border-b flex items-center justify-between pl-6 pr-6 sticky top-0 z-30 transition-colors duration-300`}>
      {/* Search bar */}
      <div className="flex-1 max-w-md">
        <div className="relative">
          <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${darkMode ? 'text-[#6E7681]' : 'text-[#5E6C84]'}`} />
          <input
            type="text"
            placeholder="Search..."
            className={`w-full pl-9 pr-3 py-1.5 border border-transparent rounded-md text-sm transition-all outline-none ${
              darkMode
                ? 'bg-[#1C2333] text-[#E6EDF3] placeholder-[#6E7681] hover:bg-[#242C3D] focus:bg-[#0D1117] focus:border-[#58A6FF] focus:ring-1 focus:ring-[#58A6FF]'
                : 'bg-[#F1F2F4] text-[#172B4D] placeholder-[#8993A4] hover:bg-[#E9EAEE] focus:bg-white focus:border-[#0C66E4] focus:ring-1 focus:ring-[#0C66E4]'
            }`}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Dark Mode Toggle */}
        <button
          onClick={toggleDarkMode}
          className={`relative p-2 rounded-md transition-colors ${
            darkMode
              ? 'text-[#E3B341] hover:text-[#F0D961] hover:bg-[#1C2333]'
              : 'text-[#5E6C84] hover:text-[#172B4D] hover:bg-[#F1F2F4]'
          }`}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {darkMode ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
        </button>

        {/* Notifications */}
        <button
          className={`relative p-2 rounded-md transition-colors ${
            darkMode
              ? 'text-[#8B949E] hover:text-[#E6EDF3] hover:bg-[#1C2333]'
              : 'text-[#5E6C84] hover:text-[#172B4D] hover:bg-[#F1F2F4]'
          }`}
          aria-label="Notifications"
        >
          <Bell className="w-[18px] h-[18px]" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[#C9372C] rounded-full ring-2 ring-white dark:ring-[#161B22]" />
        </button>

        {/* User Profile */}
        <div className={`flex items-center gap-3 pl-3 ml-2 border-l ${darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]'}`}>
          <div className="text-right hidden sm:block">
            <p className={`text-sm font-medium leading-tight ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>DevOps Admin</p>
            <p className={`text-xs leading-tight ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>admin@company.com</p>
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
