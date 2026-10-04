import React, { useState, useRef } from 'react';
import { Play, Pause, Film, FastForward, Rewind, Maximize2 } from 'lucide-react';

const API_BASE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
  ? String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, '')
  : 'http://localhost:3001';

/**
 * VideoPlayer — plays .webm Playwright recordings with speed controls.
 *
 * Props:
 *   videos: [{ url, fileName }]
 *   darkMode: optional; matches ProjectDashboard / ScriptDetail theme
 */
export default function VideoPlayer({ videos = [], darkMode = false }) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef(null);

  const btnInactive = darkMode
    ? 'bg-[#30363D] border-[#30363D] text-[#8B949E] hover:text-[#E6EDF3] hover:border-[#484F58]'
    : 'bg-[#F4F5F7] border-[#DFE1E6] text-[#8993A4] hover:text-[#5E6C84]';

  const btnSelected = darkMode
    ? 'bg-[rgba(56,139,253,0.15)] border-[rgba(56,139,253,0.4)] text-[#58A6FF] font-semibold'
    : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-500 font-semibold';

  const playBtn = darkMode
    ? 'bg-[rgba(56,139,253,0.15)] border-[rgba(56,139,253,0.35)] text-[#58A6FF] hover:bg-[rgba(56,139,253,0.25)]'
    : 'bg-indigo-500/15 border border-indigo-500/30 text-indigo-500 hover:bg-indigo-500/25';

  const frameBorder = darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]';

  const mutedText = darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]';

  if (!videos || videos.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center py-8 ${mutedText}`}>
        <Film className="w-8 h-8 mb-2 opacity-20" />
        <p className="text-sm">No video recordings available</p>
        <p className="text-[10px] mt-1 opacity-70">Videos are captured when Playwright tests run with video: 'on'</p>
      </div>
    );
  }

  const currentVideo = videos[selectedIdx];
  const videoUrl = `${API_BASE}${currentVideo.url}`;
  const speeds = [0.5, 1, 1.5, 2];

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const setSpeed = (rate) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  const handleFullscreen = () => {
    videoRef.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="space-y-2">
      {/* Video selector if multiple */}
      {videos.length > 1 && (
        <div className="flex gap-1 flex-wrap">
          {videos.map((v, idx) => (
            <button
              key={v.url}
              onClick={() => { setSelectedIdx(idx); setIsPlaying(false); }}
              className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                idx === selectedIdx ? btnSelected : btnInactive
              }`}
            >
              {v.fileName}
            </button>
          ))}
        </div>
      )}

      {/* Video element */}
      <div className={`relative rounded overflow-hidden border bg-[#171717] ${frameBorder}`}>
        <video
          ref={videoRef}
          key={videoUrl}
          src={videoUrl}
          className="w-full max-h-80 object-contain"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onLoadedMetadata={(e) => { e.target.playbackRate = playbackRate; }}
          preload="metadata"
        />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            onClick={togglePlay}
            className={`p-1.5 rounded border transition-colors ${playBtn}`}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleFullscreen}
            className={`p-1.5 rounded border transition-colors ${btnInactive}`}
            title="Fullscreen"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Speed controls */}
        <div className="flex items-center gap-1">
          <span className={`text-[10px] mr-1 ${mutedText}`}>Speed:</span>
          {speeds.map(rate => (
            <button
              key={rate}
              onClick={() => setSpeed(rate)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                playbackRate === rate ? btnSelected : btnInactive
              }`}
            >
              {rate}x
            </button>
          ))}
        </div>
      </div>

      {/* Download link */}
      <a
        href={videoUrl}
        download={currentVideo.fileName}
        className={`block text-[10px] hover:underline ${darkMode ? 'text-[#58A6FF]' : 'text-indigo-500'}`}
      >
        Download {currentVideo.fileName}
      </a>
    </div>
  );
}
