import React, { useState, useEffect, useRef } from 'react';
import { Monitor, Maximize2, Minimize2, Wifi, WifiOff, Loader } from 'lucide-react';

/**
 * LiveBrowserPanel — embeds the noVNC viewer for live Playwright test streaming.
 *
 * Props:
 *   vncContainers: [{ containerId, containerName, vncPort, vncUrl, status }]
 *   currentExecution: { testCaseId, scenarioId, title, containerName } | null
 *   isRunning: boolean
 */
export default function LiveBrowserPanel({ vncContainers = [], currentExecution = null, isRunning = false }) {
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

  // No VNC containers available
  if (vncContainers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg text-[#8993A4]">
        <Monitor className="w-12 h-12 mb-3 opacity-20" />
        <p className="text-sm font-medium">Live Browser</p>
        <p className="text-xs mt-1 opacity-70">
          {isRunning ? 'Waiting for browser session...' : 'No active browser session'}
        </p>
        {isRunning && <Loader className="w-4 h-4 mt-3 animate-spin opacity-40" />}
      </div>
    );
  }

  return (
    <div ref={panelRef} className="flex flex-col h-full bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg overflow-hidden">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#DFE1E6] bg-[#EBECF0]">
        <div className="flex items-center gap-2">
          <Monitor className="w-3.5 h-3.5 text-[#5E6C84]" />
          <span className="text-xs font-bold text-[#5E6C84] uppercase tracking-wider">Live Browser</span>
          {isContainerActive && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 border border-green-500/30 text-[#00875A] font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00875A] animate-pulse" />
              LIVE
            </span>
          )}
          {!isContainerActive && vncUrl && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-[#DFE1E6] border border-[#C1C7D0] text-[#8993A4] font-semibold">
              IDLE
            </span>
          )}
        </div>
        <button
          onClick={toggleFullscreen}
          className="p-1 rounded hover:bg-[#DFE1E6] text-[#8993A4] hover:text-[#5E6C84] transition-colors"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Current Test Indicator */}
      {currentExecution && isContainerActive && (
        <div className="px-3 py-1.5 bg-indigo-500/10 border-b border-indigo-500/20 flex items-center gap-2">
          <Loader className="w-3 h-3 text-indigo-500 animate-spin flex-shrink-0" />
          <span className="text-[10px] text-indigo-600 font-medium truncate">
            Executing: {currentExecution.title || currentExecution.testCaseId}
          </span>
        </div>
      )}

      {/* VNC Iframe */}
      <div className="flex-1 relative bg-[#171717] min-h-0">
        {!iframeLoaded && !connectionError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-[#8993A4] z-10">
            <Loader className="w-6 h-6 animate-spin mb-2" />
            <p className="text-xs">Connecting to browser...</p>
          </div>
        )}
        {connectionError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-[#C9372C] z-10">
            <WifiOff className="w-6 h-6 mb-2" />
            <p className="text-xs">Connection failed</p>
            <button
              onClick={() => { setConnectionError(false); setIframeLoaded(false); }}
              className="mt-2 text-[10px] px-2 py-1 rounded bg-[#DFE1E6] text-[#5E6C84] hover:bg-[#C1C7D0] transition-colors"
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
        <div className="flex border-t border-[#DFE1E6] bg-[#EBECF0]">
          {vncContainers.map((container, idx) => {
            const isActive = currentExecution?.containerName === container.containerName;
            const isSelected = idx === selectedContainer;
            return (
              <button
                key={container.containerId || idx}
                onClick={() => setSelectedContainer(idx)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium transition-colors border-b-2 ${
                  isSelected
                    ? 'border-indigo-500 text-indigo-600 bg-[#F4F5F7]'
                    : 'border-transparent text-[#8993A4] hover:text-[#5E6C84] hover:bg-[#DFE1E6]'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${
                  isActive ? 'bg-[#00875A] animate-pulse' : 'bg-[#C1C7D0]'
                }`} />
                Container {container.containerId || idx + 1}
                {isActive && <span className="text-[#00875A]">● Live</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
