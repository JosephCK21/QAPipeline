import React, { useState, useEffect, useRef } from 'react';
import { Monitor, Maximize2, Minimize2, Wifi, WifiOff, Loader } from 'lucide-react';

/**
 * LiveBrowserPanel — embeds the noVNC viewer for live Playwright test streaming.
 *
 * Props:
 *   vncContainers: [{ containerId, containerName, vncPort, vncUrl, status }]
 *   currentExecution: { testCaseId, scenarioId, title, containerName } | null
 *   isRunning: boolean
 *   darkMode: optional theme for empty state and chrome
 */
export default function LiveBrowserPanel({ vncContainers = [], currentExecution = null, isRunning = false, darkMode = false }) {
  const [selectedContainer, setSelectedContainer] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const panelRef = useRef(null);
  const iframeRef = useRef(null);

  // Auto-select the container that's currently executing
  useEffect(() => {
    if (currentExecution?.containerName && vncContainers.length > 0) {
      const idx = vncContainers.findIndex(c => c.containerName === currentExecution.containerName);
      if (idx >= 0) setSelectedContainer(idx);
    }
  }, [currentExecution, vncContainers]);

  // Reset iframe loaded state when switching containers
  useEffect(() => {
    setIframeLoaded(false);
    setConnectionError(false);
  }, [selectedContainer]);

  const toggleFullscreen = () => {
    if (!panelRef.current) return;
    if (!isFullscreen) {
      panelRef.current.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
    setIsFullscreen(f => !f);
  };

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const activeContainer = vncContainers[selectedContainer];
  const vncUrl = activeContainer?.vncUrl || null;
  const isContainerActive = activeContainer && currentExecution?.containerName === activeContainer.containerName;

  const shell = darkMode
    ? 'bg-[#161B22] border-[#30363D] text-[#8B949E]'
    : 'bg-[#F4F5F7] border-[#DFE1E6] text-[#8993A4]';
  const headerBar = darkMode
    ? 'border-[#30363D] bg-[#1C2333]'
    : 'border-[#DFE1E6] bg-[#EBECF0]';
  const headerText = darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]';
  const iconHeader = darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]';
  const btnGhost = darkMode
    ? 'hover:bg-[#30363D] text-[#8B949E] hover:text-[#E6EDF3]'
    : 'hover:bg-[#DFE1E6] text-[#8993A4] hover:text-[#5E6C84]';
  const idleChip = darkMode
    ? 'bg-[#30363D] border-[#484F58] text-[#8B949E]'
    : 'bg-[#DFE1E6] border-[#C1C7D0] text-[#8993A4]';
  const liveChip = darkMode
    ? 'bg-[rgba(63,185,80,0.15)] border-[rgba(63,185,80,0.35)] text-[#3FB950]'
    : 'bg-green-500/15 border-green-500/30 text-[#00875A]';
  const liveDot = darkMode ? 'bg-[#3FB950]' : 'bg-[#00875A]';
  const execBar = darkMode
    ? 'bg-[rgba(56,139,253,0.1)] border-indigo-500/25'
    : 'bg-indigo-500/10 border-indigo-500/20';
  const execText = darkMode ? 'text-[#58A6FF]' : 'text-indigo-600';
  const retryBtn = darkMode
    ? 'bg-[#30363D] text-[#E6EDF3] hover:bg-[#484F58]'
    : 'bg-[#DFE1E6] text-[#5E6C84] hover:bg-[#C1C7D0]';

  // No VNC containers available
  if (vncContainers.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center h-full w-full min-w-0 flex-1 border rounded-lg ${shell}`}>
        <Monitor className="w-12 h-12 mb-3 opacity-20" />
        <p className={darkMode ? 'text-sm font-medium text-[#E6EDF3]' : 'text-sm font-medium'}>Live Browser</p>
        <p className="text-xs mt-1 opacity-70">
          {isRunning ? 'Waiting for browser session...' : 'No active browser session'}
        </p>
        {isRunning && <Loader className="w-4 h-4 mt-3 animate-spin opacity-40" />}
      </div>
    );
  }

  return (
    <div ref={panelRef} className={`flex flex-col h-full w-full min-w-0 flex-1 border rounded-lg overflow-hidden ${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#F4F5F7] border-[#DFE1E6]'}`}>
      {/* Panel Header */}
      <div className={`flex items-center justify-between px-3 py-2 border-b ${headerBar}`}>
        <div className="flex items-center gap-2">
          <Monitor className={`w-3.5 h-3.5 ${iconHeader}`} />
          <span className={`text-xs font-bold uppercase tracking-wider ${headerText}`}>Live Browser</span>
          {isContainerActive && (
            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-semibold ${liveChip}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${liveDot} animate-pulse`} />
              LIVE
            </span>
          )}
          {!isContainerActive && vncUrl && (
            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-semibold ${idleChip}`}>
              IDLE
            </span>
          )}
        </div>
        <button
          onClick={toggleFullscreen}
          className={`p-1 rounded transition-colors ${btnGhost}`}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Current Test Indicator */}
      {currentExecution && isContainerActive && (
        <div className={`px-3 py-1.5 border-b flex items-center gap-2 ${execBar}`}>
          <Loader className={`w-3 h-3 animate-spin flex-shrink-0 ${darkMode ? 'text-[#58A6FF]' : 'text-indigo-500'}`} />
          <span className={`text-[10px] font-medium truncate ${execText}`}>
            Executing: {currentExecution.title || currentExecution.testCaseId}
          </span>
        </div>
      )}

      {/* VNC Iframe */}
      <div className="flex-1 relative bg-[#171717] min-h-0">
        {!iframeLoaded && !connectionError && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center z-10 ${darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]'}`}>
            <Loader className="w-6 h-6 animate-spin mb-2" />
            <p className="text-xs">Connecting to browser...</p>
          </div>
        )}
        {connectionError && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center z-10 ${darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'}`}>
            <WifiOff className="w-6 h-6 mb-2" />
            <p className="text-xs">Connection failed</p>
            <button
              onClick={() => { setConnectionError(false); setIframeLoaded(false); }}
              className={`mt-2 text-[10px] px-2 py-1 rounded transition-colors ${retryBtn}`}
            >
              Retry
            </button>
          </div>
        )}
        {vncUrl && (
          <iframe
            ref={iframeRef}
            key={`vnc-${selectedContainer}-${vncUrl}`}
            src={vncUrl}
            title="Live Browser Session"
            className="w-full h-full border-none"
            style={{ opacity: iframeLoaded ? 1 : 0 }}
            onLoad={() => setIframeLoaded(true)}
            onError={() => setConnectionError(true)}
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
          />
        )}
      </div>

      {/* Container Tabs */}
      {vncContainers.length > 1 && (
        <div className={`flex border-t ${darkMode ? 'border-[#30363D] bg-[#1C2333]' : 'border-[#DFE1E6] bg-[#EBECF0]'}`}>
          {vncContainers.map((container, idx) => {
            const isActive = currentExecution?.containerName === container.containerName;
            const isSelected = idx === selectedContainer;
            return (
              <button
                key={container.containerId || idx}
                onClick={() => setSelectedContainer(idx)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium transition-colors border-b-2 ${
                  isSelected
                    ? darkMode
                      ? 'border-[#58A6FF] text-[#58A6FF] bg-[#161B22]'
                      : 'border-indigo-500 text-indigo-600 bg-[#F4F5F7]'
                    : darkMode
                      ? 'border-transparent text-[#6E7681] hover:text-[#8B949E] hover:bg-[#21262D]'
                      : 'border-transparent text-[#8993A4] hover:text-[#5E6C84] hover:bg-[#DFE1E6]'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${
                  isActive ? `${darkMode ? 'bg-[#3FB950]' : 'bg-[#00875A]'} animate-pulse` : (darkMode ? 'bg-[#484F58]' : 'bg-[#C1C7D0]')
                }`} />
                Container {container.containerId || idx + 1}
                {isActive && <span className={darkMode ? 'text-[#3FB950]' : 'text-[#00875A]'}>● Live</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
