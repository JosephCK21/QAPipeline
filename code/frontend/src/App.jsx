import React, { useState, useEffect, createContext, useContext } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { io } from 'socket.io-client';
import Sidebar from './components/Sidebar';
import Navbar from './components/Navbar';
import ProjectsHub from './pages/ProjectsHub';
import ProjectDashboard from './pages/ProjectDashboard';
import ProjectSettings from './pages/ProjectSettings';
import PipelineRunsList from './pages/PipelineRunsList';
import ScriptDetail from './pages/ScriptDetail';
import AgentChatDebug from './pages/AgentChatDebug';

// Create context for global state
export const AppContext = createContext();

export const useAppContext = () => useContext(AppContext);

function App() {
  const [activeRuns, setActiveRuns] = useState([]);
  const [toast, setToast] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // For forcing child components to re-fetch data
  const [llmTraces, setLlmTraces] = useState([]);
  const [vncContainers, setVncContainers] = useState([]); // Live browser VNC containers
  const [liveExecution, setLiveExecution] = useState(null); // Currently executing test case
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem('darkMode');
    return stored === 'true';
  });

  // Load initial data and Socket.io listeners
  useEffect(() => {
    const socket = io('http://localhost:3001');

    socket.on('connect', () => console.log('Connected to AutoQA backend WebSocket!'));
    
    socket.on('pr_opened', (data) => {
        setToast({ message: `New PR received for ${data.repoFullName}! Pipeline started.`, type: 'success' });
        setTimeout(() => setToast(null), 5000);
    });

    socket.on('repo_created', (data) => {
        setToast({ message: `New repository detected: ${data.repoFullName}`, type: 'info' });
        setTimeout(() => setToast(null), 5000);
    });

    socket.on('branch_created', (data) => {
        setToast({ message: `New branch '${data.branchName}' detected in ${data.repoFullName}`, type: 'info' });
        setTimeout(() => setToast(null), 5000);
    });

    socket.on('run_updated', (run) => {
        if (run.status === 'completed') {
            setToast({ message: `Testing completed successfully for run ${run.runId.substring(0,6)}`, type: 'success' });
            setTimeout(() => setToast(null), 5000);
        } else if (run.status === 'error' || run.status === 'failed') {
            setToast({ message: `Execution failed for run ${run.runId.substring(0,6)}`, type: 'error' });
            setTimeout(() => setToast(null), 5000);
        }
    });

    socket.on('jira_story_triggered', (data) => {
      setToast({ message: `Jira story ${data.issueKey} triggered run ${data.runId.substring(0, 6)}...`, type: 'info' });
      setTimeout(() => setToast(null), 5000);
    });

    socket.on('jira_rtm_updated', () => {
      setRefreshKey((prev) => prev + 1);
    });

    socket.on('jira_queue_updated', () => {
      setRefreshKey((prev) => prev + 1);
    });

    socket.on('jira_run_updated', (data) => {
      if (data.status === 'completed') {
        setToast({ message: `Jira run completed for ${data.issueKey}`, type: 'success' });
        setTimeout(() => setToast(null), 5000);
      }
      if (data.status === 'error') {
        setToast({ message: `Jira run failed for ${data.issueKey}`, type: 'error' });
        setTimeout(() => setToast(null), 5000);
      }
    });

    socket.on('refresh_data', () => {
        setRefreshKey(prev => prev + 1); // Trigger useEffects in child components
    });

    socket.on('llm_trace', (trace) => {
        setLlmTraces(prev => [...prev.slice(-199), trace]); // keep last 200
    });

    // --- Live browser VNC events ---
    socket.on('sandbox_vnc_ready', (data) => {
        setVncContainers(prev => {
            // Avoid duplicates
            if (prev.some(c => c.containerId === data.containerId && c.runId === data.runId)) return prev;
            return [...prev, data];
        });
    });

    socket.on('run_updated', (updateData) => {
        // Clear VNC containers when run completes
        if (updateData.type === 'complete') {
            setVncContainers([]);
            setLiveExecution(null);
        }
    });

    socket.on('test_execution_started', (data) => {
        setLiveExecution(data);
    });

    socket.on('test_execution_ended', () => {
        setLiveExecution(null);
    });

    return () => socket.disconnect();
  }, []);

  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  };

  // Dark mode: sync .dark class on <html> and persist preference
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('darkMode', darkMode);
  }, [darkMode]);

  const toggleDarkMode = () => setDarkMode(prev => !prev);

  const contextValue = {
    activeRuns,
    setActiveRuns,
    showToast,
    sidebarCollapsed,
    setSidebarCollapsed,
    refreshKey, // Exporting to child components to trigger data refresh automatically
    llmTraces,
    setLlmTraces,
    vncContainers,
    liveExecution,
    darkMode,
    toggleDarkMode
  };

  return (
    <AppContext.Provider value={contextValue}>
      <Router>
        <div className={`flex min-h-screen ${darkMode ? 'bg-[#0D1117]' : 'bg-[#F4F5F7]'}`}>
          <Sidebar />
          <div className={`flex-1 flex flex-col transition-all duration-300 ${sidebarCollapsed ? 'ml-16' : 'ml-64'}`}>
            <Navbar />
            <main className={`flex-1 p-6 overflow-auto ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>
              <Routes>
                <Route path="/" element={<ProjectsHub />} />
                <Route path="/projects/:projectId" element={<ProjectDashboard />} />
                <Route path="/projects/:projectId/settings" element={<ProjectSettings />} />
                <Route path="/pipelines" element={<PipelineRunsList />} />
                <Route path="/projects/:projectId/run/:runId/scripts" element={<ScriptDetail />} />
                <Route path="/llm-traces" element={<AgentChatDebug />} />
              </Routes>
            </main>
          </div>

          {/* Toast Notification */}
          {toast && (
            <div className={`fixed bottom-6 right-6 px-5 py-3 rounded-md shadow-lg animate-slide-in z-50 border ${
              toast.type === 'success' ? 'bg-[#E3FCEF] border-[#ABF5D1] text-[#006644]' :
              toast.type === 'error'   ? 'bg-[#FFEBE6] border-[#FFBDAD] text-[#A61C00]' :
                                         'bg-[#DEEBFF] border-[#B3D4FF] text-[#0747A6]'
            }`}>
              <p className="font-medium text-sm">{toast.message}</p>
            </div>
          )}
        </div>
      </Router>
    </AppContext.Provider>
  );
}

export default App;