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
  const [settings, setSettings] = useState({
    reasoningModel: 'gpt-4-turbo',
    codingModel: 'claude-3-opus',
    largeContextModel: 'gemini-1.5-pro'
  });
  const [dashboardMetrics, setDashboardMetrics] = useState({
    activeSandboxes: 0,
    healingSuccessRate: 0,
    mergesBlocked: 0
  });
  const [branchPolicies, setBranchPolicies] = useState([]);
  const [sandboxMatrix, setSandboxMatrix] = useState([]);
  const [healingHistory, setHealingHistory] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [toast, setToast] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // For forcing child components to re-fetch data

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

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    const loadData = async () => {
      try {
        const storedSettings = localStorage.getItem('settings');
        
        if (storedSettings) {
          setSettings(JSON.parse(storedSettings));
        }
      } catch (error) {
        console.error('Error loading data:', error);
      }
    };
    
    loadData();
  }, []);

  // Persist settings to localStorage
  useEffect(() => {
    localStorage.setItem('settings', JSON.stringify(settings));
  }, [settings]);

  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  };

  const updateSettings = (newSettings) => {
    setSettings(newSettings);
    showToast('Settings updated successfully!', 'success');
  };

  const contextValue = {
    activeRuns,
    setActiveRuns,
    settings,
    updateSettings,
    dashboardMetrics,
    branchPolicies,
    sandboxMatrix,
    healingHistory,
    auditLogs,
    selectedRun,
    setSelectedRun,
    showToast,
    sidebarCollapsed,
    setSidebarCollapsed,
    refreshKey // Exporting to child components to trigger data refresh automatically
  };

  return (
    <AppContext.Provider value={contextValue}>
      <Router>
        <div className="flex min-h-screen bg-[#121212]">
          <Sidebar />
          <div className={`flex-1 flex flex-col transition-all duration-300 ${sidebarCollapsed ? 'ml-16' : 'ml-64'}`}>
            <Navbar />
            <main className="flex-1 p-6 overflow-auto">
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
            <div className={`fixed bottom-6 right-6 px-6 py-4 rounded-lg shadow-lg animate-slide-in z-50 ${
              toast.type === 'success' ? 'bg-green-600' : 
              toast.type === 'error' ? 'bg-red-600' : 'bg-[#6272A4]'
            }`}>
              <p className="text-white font-medium">{toast.message}</p>
            </div>
          )}
        </div>
      </Router>
    </AppContext.Provider>
  );
}

export default App;