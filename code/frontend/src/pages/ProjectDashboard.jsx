import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Activity, ShieldCheck, Bug, Clock, GitCommit, Search, ChevronRight, ChevronDown, X, AlertTriangle, Settings, CheckCircle2, XCircle, Loader, PlayCircle, FileText, Upload, Trash2, Code2, Database, ListChecks, RefreshCw, GitBranch, ExternalLink, TrendingUp, Zap, BarChart2 } from 'lucide-react';
import { useAppContext } from '../App';
import { computeAllEpicMetrics } from '../lib/epicMetrics';
import { JIRA_BASE_URL } from '../lib/env';
import EpicStackedChart from '../components/EpicStackedChart';

function normTcStatus(s) {
  return String(s || '').toLowerCase();
}

/** Per–test-case chip: border/background classes for RTM matrix */
function testCaseChipClasses(tc, darkMode) {
  const s = normTcStatus(tc.status);
  if (s === 'pass') {
    return darkMode
      ? 'bg-[rgba(63,185,80,0.1)] border-[rgba(63,185,80,0.3)] text-[#3FB950] hover:bg-[rgba(63,185,80,0.15)]'
      : 'bg-green-500/10 border-green-500/30 text-[#00875A] hover:bg-green-500/20';
  }
  if (s === 'fail') {
    return darkMode
      ? 'bg-[rgba(248,81,73,0.1)] border-[rgba(248,81,73,0.3)] text-[#F85149] hover:bg-[rgba(248,81,73,0.15)]'
      : 'bg-red-500/10 border-red-500/30 text-[#C9372C] hover:bg-red-500/20';
  }
  if (s === 'running') {
    return darkMode
      ? 'bg-[rgba(210,153,34,0.12)] border-[rgba(210,153,34,0.45)] text-[#D29922] hover:bg-[rgba(210,153,34,0.18)]'
      : 'bg-amber-500/10 border-amber-500/35 text-[#B65C00] hover:bg-amber-500/15';
  }
  if (s === 'healing') {
    return darkMode
      ? 'bg-[rgba(56,139,253,0.12)] border-[rgba(56,139,253,0.4)] text-[#58A6FF] hover:bg-[rgba(56,139,253,0.18)]'
      : 'bg-blue-500/10 border-blue-500/35 text-[#0C66E4] hover:bg-blue-500/15';
  }
  return darkMode
    ? 'bg-[#30363D]/50 border-[#484F58]/50 text-[#8B949E] hover:bg-[#30363D]'
    : 'bg-[#DFE1E6]/30 border-[#C1C7D0]/30 text-[#5E6C84] hover:bg-[#DFE1E6]/50';
}

/** Scenario card dot: aggregate from test cases + execStatus */
function scenarioHeaderDotMeta(tcs, execStatus, darkMode) {
  const st = normTcStatus(execStatus);
  if (st === 'fail') return { cls: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]', label: 'fail' };
  const statuses = (tcs || []).map((t) => normTcStatus(t.status));
  if (statuses.some((x) => x === 'healing')) return { cls: 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.7)]', label: 'healing' };
  if (statuses.some((x) => x === 'running')) return { cls: 'bg-yellow-500 shadow-[0_0_5px_rgba(234,179,8,0.5)]', label: 'running' };
  if (st === 'pass') return { cls: 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]', label: 'pass' };
  return { cls: darkMode ? 'bg-[#6E7681]' : 'bg-[#8993A4]', label: 'pending' };
}

function ProjectDashboard() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { showToast, refreshKey, darkMode } = useAppContext();
  
  const [project, setProject] = useState(null);
  const [rtm, setRtm] = useState({ requirements: [], scenarios: [] });
  const [rtmStats, setRtmStats] = useState({ totalReqs: 0, testedScenarios: 0, coverage: 0, totalScenarios: 0 });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [projectRuns, setProjectRuns] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  
  // Slide-in panel state
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedTestCase, setSelectedTestCase] = useState(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState('scenario'); // 'scenario' | 'testcase'
  // Which scenario cards are expanded to show test cases
  const [expandedScenarios, setExpandedScenarios] = useState({});
  // Code/data view toggle inside test case panel
  const [tcPanelTab, setTcPanelTab] = useState('steps'); // 'steps' | 'script' | 'data'

  useEffect(() => {
    fetchProjectData();
    fetchRtmData();
    fetchProjectRuns();
    fetchDocuments();
  }, [projectId, refreshKey]);

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${projectId}/jira-documents`);
      if (res.ok) {
        const data = await res.json();
        setDocuments(data || []);
      }
    } catch(err) {
      console.error(err);
    }
  };

  const handleUploadDocument = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadingDocs(true);
    
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }
    
    try {
        const res = await fetch(`http://localhost:3001/api/projects/${projectId}/jira-documents`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`Successfully uploaded ${data.uploadedCount} documents`, 'success');
            fetchDocuments();
        } else {
            showToast(`Upload failed: ${data.error}`, 'error');
        }
    } catch(err) {
        console.error(err);
        showToast('Error uploading documents', 'error');
    } finally {
        setUploadingDocs(false);
        e.target.value = null; // reset file input
    }
  };

  const handleDeleteRun = async (runId, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this run and all its test cases? This cannot be undone.')) return;
    try {
      const res = await fetch(`http://localhost:3001/api/runs/${runId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Run deleted — re-trigger the PR to start fresh.', 'success');
        setProjectRuns(prev => prev.filter(r => r.runId !== runId));
      } else {
        const data = await res.json();
        showToast(`Failed to delete run: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast('Error deleting run', 'error');
    }
  };

  const handleDeleteDocument = async (filePath) => {
      try {
          const res = await fetch(`http://localhost:3001/api/projects/${projectId}/jira-documents`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filePath })
          });
          if (res.ok) {
              showToast('Document removed', 'success');
              fetchDocuments();
          } else {
              const data = await res.json();
              showToast(`Failed to remove document: ${data.error}`, 'error');
          }
      } catch(err) {
          console.error(err);
          showToast('Error removing document', 'error');
      }
  };

  const fetchProjectRuns = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/runs`);
      if (res.ok) {
        const allRuns = await res.json();
        // Filter runs to those matching this project
        const runsForProject = allRuns.filter(r => r.localProjectId === projectId);
        // Sort newest first
        runsForProject.sort((a, b) => new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0));
        setProjectRuns(runsForProject);
      }
    } catch(err) {
      console.error(err);
    }
  };

  const handleSyncJira = async () => {
    if (!project?.jiraProjectKey) {
      showToast('No Jira Space linked. Go to Project Settings to link one first.', 'error');
      return;
    }
    setSyncing(true);
    showToast('Syncing with Jira...', 'info');
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${projectId}/sync-jira`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to sync Jira');
      showToast(data.message || `Jira sync complete. Queued ${data.queuedCount} items.`, 'success');
      // Fetch UI updates to see the queued things quickly
      setTimeout(() => fetchProjectRuns(), 1000);
    } catch (error) {
      showToast(`Sync failed: ${error.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const fetchProjectData = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${projectId}`);
      if (!res.ok) throw new Error('Failed to fetch project');
      const data = await res.json();
      setProject(data);
    } catch (err) {
      console.error(err);
      showToast('Error loading project details', 'error');
    }
  };

  const fetchRtmData = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${projectId}/jira-rtm`);
      if (res.ok) {
        const data = await res.json();

        setRtm(data);
        
        const reqsCount = data.requirements?.length || 0;
        const totalScenariosCount = data.scenarios?.length || 0;
        const covered = data.scenarios?.filter(s => ['pass', 'fail', 'completed'].includes((s.execStatus || '').toLowerCase()))?.length || 0;
        
        setRtmStats({
            totalReqs: reqsCount,
            testedScenarios: covered,
            totalScenarios: totalScenariosCount,
            coverage: totalScenariosCount > 0 ? Math.round((covered / totalScenariosCount) * 100) : 0
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const filteredRequirements = rtm.requirements?.filter(r => 
    r.description?.toLowerCase().includes(searchQuery.toLowerCase()) || 
    r.reqId?.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const groupedRequirements = filteredRequirements.reduce((acc, req) => {
    const epic = req.epicKey || 'UNSCOPED';
    if (!acc[epic]) acc[epic] = [];
    acc[epic].push(req);
    return acc;
  }, {});

  const epicMetrics = useMemo(
    () => computeAllEpicMetrics(groupedRequirements, rtm.scenarios),
    [groupedRequirements, rtm.scenarios]
  );

  const openScenarioDetails = (scenario) => {
      setSelectedItem(scenario);
      setPanelMode('scenario');
      setIsPanelOpen(true);
  };

  const openTestCaseDetails = (testCase, scenario) => {
      setSelectedTestCase({ ...testCase, parentScenario: scenario });
      setTcPanelTab('steps');
      setPanelMode('testcase');
      setIsPanelOpen(true);
  };

  const toggleScenarioExpand = (scenarioId, e) => {
      e.stopPropagation();
      setExpandedScenarios(prev => ({ ...prev, [scenarioId]: !prev[scenarioId] }));
  };

  const closePanel = () => {
      setIsPanelOpen(false);
      setTimeout(() => { setSelectedItem(null); setSelectedTestCase(null); }, 300);
  };

  if (loading) {
    return <div className="p-8 text-[#5E6C84]">Loading project dashboard...</div>;
  }

  return (
    <div className="space-y-6 relative overflow-hidden h-full">
      {/* Header Info */}
      <div className={`flex justify-between items-start ${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#F4F5F7] border-[#DFE1E6]'} border p-6 rounded-lg transition-colors`}>
        <div>
          <h1 className={`text-2xl font-bold mb-2 ${darkMode ? 'text-[#E6EDF3]' : 'bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400'}`}>
            {project?.name || 'Project Dashboard'}
          </h1>
          <div className={`flex space-x-4 text-sm ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
            {project?.jiraProjectKey && (
              <span className="flex items-center"><Activity className="w-4 h-4 mr-1 text-blue-500" /> Jira: {project.jiraProjectKey}</span>
            )}
            {project?.githubRepoFullName && (
              <span className="flex items-center"><GitCommit className="w-4 h-4 mr-1 text-purple-500" /> GitHub: {project.githubRepoFullName}</span>
            )}
          </div>
        </div>
<div className="flex space-x-3 text-sm">
            <button
              onClick={handleSyncJira}
              disabled={syncing}
              className={`flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors text-sm font-medium ${syncing ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {syncing ? <Loader className="w-4 h-4 mr-2 animate-spin" /> : <Activity className="w-4 h-4 mr-2" />}
              {syncing ? 'Syncing...' : 'Sync Jira'}
            </button>
            <button 
              onClick={() => navigate(`/projects/${projectId}/settings`)}
              className={`flex items-center px-4 py-2 rounded-md border transition-colors text-sm font-medium ${
                darkMode
                  ? 'bg-[#1C2333] hover:bg-[#242C3D] text-[#E6EDF3] border-[#484F58]'
                  : 'bg-[#F1F2F4] hover:bg-[#DFE1E6] text-[#172B4D] border-[#C1C7D0]'
              }`}
            >
              <Settings className="w-4 h-4 mr-2" />
              Project Settings
            </button>
          </div>
      </div>


      <div className={`border-b ${darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]'}`}>
        <nav className="-mb-px flex space-x-8">
          {[
            { key: 'overview', label: 'Overview' },
            { key: 'rtm', label: 'Traceability Matrix' },
            { key: 'runs', label: 'Pipeline Runs' },
            { key: 'docs', label: 'Context Documents' },
          ].map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={`${
              activeTab === tab.key
                ? (darkMode ? 'border-[#58A6FF] text-[#58A6FF]' : 'border-indigo-500 text-indigo-400')
                : (darkMode ? 'border-transparent text-[#6E7681] hover:text-[#8B949E]' : 'border-transparent text-[#8993A4] hover:text-[#5E6C84]')
            } whitespace-nowrap pb-4 px-1 border-b-2 font-medium`}>{tab.label}</button>
          ))}
        </nav>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          OVERVIEW TAB
      ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'overview' && (() => {
        // Derived insight values
        const totalEpics = Object.keys(epicMetrics).length;
        const epicValues = Object.values(epicMetrics);
        const unhealthyEpics = epicValues.filter(em => em.failedScenarios > 0).length;

        // Pass Rate: passed / tested (only scenarios that have actually run)
        const totalPassedScenarios = epicValues.reduce((s, e) => s + e.passedScenariosStrict, 0);
        const totalFailedScenarios = epicValues.reduce((s, e) => s + e.failedScenarios, 0);
        const totalTestedScenarios = totalPassedScenarios + totalFailedScenarios;
        const passRate = totalTestedScenarios > 0
          ? Math.round((totalPassedScenarios / totalTestedScenarios) * 100)
          : 0;

        // Pipeline Runs: unique PRs that triggered a run
        const totalRuns = projectRuns.length;
        const prRuns = projectRuns.filter(r => r.prUrl);
        const uniquePRs = new Set(prRuns.map(r => r.prUrl)).size;
        const lastRun = projectRuns[0];
        const lastRunStatus = lastRun?.status;

        const insightCards = [
          {
            label: 'Pass Rate',
            value: `${passRate}%`,
            sub: totalTestedScenarios > 0
              ? `${totalPassedScenarios} of ${totalTestedScenarios} tested scenarios`
              : 'No scenarios tested yet',
            icon: TrendingUp,
            iconColor: passRate >= 80 ? 'text-emerald-400' : passRate >= 50 ? 'text-amber-400' : 'text-red-400',
            iconBg: passRate >= 80 ? 'bg-emerald-500/10' : passRate >= 50 ? 'bg-amber-500/10' : 'bg-red-500/10',
          },
          {
            label: 'Epic Health',
            value: unhealthyEpics === 0 ? 'All Clear' : `${unhealthyEpics} / ${totalEpics}`,
            sub: unhealthyEpics === 0 ? 'No failing epics' : `epic${unhealthyEpics !== 1 ? 's' : ''} with failures`,
            icon: ShieldCheck,
            iconColor: unhealthyEpics === 0 ? 'text-emerald-400' : 'text-red-400',
            iconBg: unhealthyEpics === 0 ? 'bg-emerald-500/10' : 'bg-red-500/10',
          },
          {
            label: 'Pipeline Runs',
            value: uniquePRs,
            sub: totalRuns > 0
              ? `${totalRuns} total run${totalRuns !== 1 ? 's' : ''}`
              : 'No runs yet',
            icon: Zap,
            iconColor: 'text-indigo-400',
            iconBg: 'bg-indigo-500/10',
          },
          {
            label: 'Epics Tracked',
            value: totalEpics,
            sub: `${rtmStats.totalReqs} user ${rtmStats.totalReqs === 1 ? 'story' : 'stories'}`,
            icon: BarChart2,
            iconColor: 'text-blue-400',
            iconBg: 'bg-blue-500/10',
          },
        ];

        return (
          <div className="space-y-6 animate-fade-in">

            {/* ── Insight KPI Cards ─────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {insightCards.map((card, i) => {
                const Icon = card.icon;
                return (
                  <div
                    key={i}
                    className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                      darkMode
                        ? 'bg-[#161B22] border-[#30363D] hover:border-[#484F58]'
                        : 'bg-white border-[#DFE1E6] hover:border-[#C1C7D0] shadow-sm'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className={`text-xs font-medium mb-0.5 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                        {card.label}
                      </p>
                      <p className={`text-2xl font-bold leading-none mb-1 ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>
                        {card.value}
                      </p>
                      <p className={`text-[10px] truncate ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`}>
                        {card.sub}
                      </p>
                    </div>
                    <div className={`flex-shrink-0 p-3 rounded-full ${card.iconBg}`}>
                      <Icon className={`w-5 h-5 ${card.iconColor}`} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Main 2-column layout ─────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

              {/* Left: Epic Stacked Bar Chart — spans 2 cols */}
              <div className={`lg:col-span-2 rounded-xl border p-6 transition-colors ${
                darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-white border-[#DFE1E6] shadow-sm'
              }`}>
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className={`text-base font-bold flex items-center gap-2 ${
                      darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'
                    }`}>
                      <BarChart2 className="w-4 h-4 text-indigo-400" />
                      Scenario Coverage by Epic
                    </h3>
                    <p className={`text-xs mt-0.5 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                      Live · updates on every PR run
                    </p>
                  </div>
                  <div className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full ${
                    darkMode ? 'bg-[#1C2333] text-[#3FB950]' : 'bg-[#E3FCEF] text-[#00875A]'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                      darkMode ? 'bg-[#3FB950]' : 'bg-[#00875A]'
                    }`} />
                    Live
                  </div>
                </div>
                <EpicStackedChart
                  epicMetrics={epicMetrics}
                  darkMode={darkMode}
                  onEpicClick={() => setActiveTab('rtm')}
                />
              </div>

              {/* Right column: Last Run + Coverage */}
              <div className="space-y-4">


                {/* Last run summary card */}
                {lastRun && (
                  <div className={`rounded-xl border p-5 transition-colors ${
                    darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-white border-[#DFE1E6] shadow-sm'
                  }`}>
                    <h3 className={`text-sm font-bold mb-3 ${
                      darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'
                    }`}>Last Pipeline Run</h3>
                    <div className="flex items-center gap-2 mb-3">
                      {lastRunStatus === 'completed'
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        : lastRunStatus === 'failed' || lastRunStatus === 'error'
                          ? <XCircle className="w-4 h-4 text-red-400" />
                          : <Loader className="w-4 h-4 text-blue-400 animate-spin" />}
                      <span className={`text-xs font-semibold ${
                        lastRunStatus === 'completed' ? (darkMode ? 'text-[#3FB950]' : 'text-[#00875A]') :
                        lastRunStatus === 'failed' || lastRunStatus === 'error' ? (darkMode ? 'text-[#F85149]' : 'text-[#C9372C]') :
                        (darkMode ? 'text-[#58A6FF]' : 'text-[#0C66E4]')
                      }`}>
                        {lastRunStatus === 'completed' ? 'Passed' : lastRunStatus === 'failed' || lastRunStatus === 'error' ? 'Failed' : 'Running'}
                      </span>
                      <span className={`text-[10px] font-mono ml-auto ${
                        darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'
                      }`}>#{lastRun.runId.substring(0, 8)}</span>
                    </div>
                    <p className={`text-[10px] mb-3 ${
                      darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'
                    }`}>
                      {new Date(lastRun.createdAt || Date.now()).toLocaleString()}
                    </p>
                    <button
                      onClick={() => navigate(`/projects/${projectId}/run/${lastRun.runId}/scripts`)}
                      className="w-full text-center text-xs font-medium px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors"
                    >
                      View Run Details
                    </button>
                  </div>
                )}

                {/* Coverage ring summary card */}
                <div className={`rounded-xl border p-5 transition-colors ${
                  darkMode ? 'bg-gradient-to-br from-[#161B22] to-[#1C2333] border-[#30363D]' : 'bg-gradient-to-br from-[#0C66E4] to-[#0747A6] border-transparent shadow-lg'
                }`}>
                  <p className={`text-xs font-semibold uppercase tracking-wider mb-1 ${
                    darkMode ? 'text-[#8B949E]' : 'text-white/70'
                  }`}>Feature Coverage</p>
                  <p className={`text-4xl font-extrabold mb-1 ${
                    darkMode ? 'text-[#E6EDF3]' : 'text-white'
                  }`}>{rtmStats.coverage}%</p>
                  <p className={`text-xs ${
                    darkMode ? 'text-[#6E7681]' : 'text-white/80'
                  }`}>
                    {rtmStats.testedScenarios} of {rtmStats.totalScenarios} scenarios tested
                  </p>
                  {/* Mini progress bar */}
                  <div className={`mt-3 h-1.5 rounded-full overflow-hidden ${
                    darkMode ? 'bg-[#30363D]' : 'bg-white/25'
                  }`}>
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${
                        darkMode ? 'bg-gradient-to-r from-emerald-500 to-green-400' : 'bg-white'
                      }`}
                      style={{ width: `${rtmStats.coverage}%` }}
                    />
                  </div>
                </div>

              </div>
            </div>
          </div>
        );
      })()}

      {/* RTM View */}
      {activeTab === 'rtm' && (
        <div className={`${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#F4F5F7] border-[#DFE1E6]'} border rounded-lg overflow-hidden transition-colors`}>
          <div className={`p-4 border-b ${darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]'} flex justify-between items-center`}>
             <div className="relative w-64">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className={`h-4 w-4 ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`} />
                </div>
                <input
                  type="text"
                  placeholder="Search requirements..."
                  className={`block w-full pl-10 pr-3 py-2 border rounded-md leading-5 sm:text-sm focus:outline-none focus:ring-1 ${
                    darkMode
                      ? 'border-[#484F58] bg-[#1C2333] text-[#E6EDF3] placeholder-[#6E7681] focus:border-[#58A6FF] focus:ring-[#58A6FF]'
                      : 'border-[#C1C7D0] bg-[#F1F2F4] text-[#5E6C84] placeholder-gray-500 focus:border-indigo-500 focus:ring-indigo-500'
                  }`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
             </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className={`min-w-full divide-y border-collapse ${darkMode ? 'divide-[#30363D]' : 'divide-gray-800'}`}>
                <thead className={darkMode ? 'bg-[#1C2333]' : 'bg-[#F4F5F7]'}>
                  <tr>
                    <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider w-1/4 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>Requirement</th>
                    <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>Test Scenarios</th>
                    <th scope="col" className={`px-6 py-3 text-left text-xs font-medium uppercase tracking-wider w-[140px] ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>Test Cases</th>
                  </tr>
                </thead>
                <tbody className={`${darkMode ? 'bg-[#161B22]' : 'bg-[#F4F5F7]'} divide-y ${darkMode ? 'divide-[#30363D]' : 'divide-gray-800'}`}>
                    {Object.keys(groupedRequirements).length > 0 ? (
                      Object.entries(groupedRequirements).map(([epicKey, reqs]) => {
                        const em = epicMetrics[epicKey] || {
                          total: 0, done: 0, notDone: 0, passed: 0, failed: 0, donePct: 0,
                          totalScenarios: 0, passedScenariosStrict: 0, failedScenarios: 0, pendingScenarios: 0, scenarioPassPct: 0,
                        };
                        const epicUrl = JIRA_BASE_URL ? `${JIRA_BASE_URL}/browse/${epicKey}` : null;
                        return (
                        <React.Fragment key={epicKey}>
                          {/* ═══════ REDESIGNED EPIC HEADER ═══════ */}
                          <tr className={darkMode ? 'bg-[#1C2333]' : 'bg-[#F1F2F4]'}>
                            <td colSpan="3" className={`px-6 py-4 border-b ${darkMode ? 'border-[#30363D]' : 'border-indigo-500/20'}`}>
                              <div className="space-y-3">
                                {/* Row 1: Identity — Epic key, story count, pass % */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    {epicUrl ? (
                                      <a
                                        href={epicUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={`inline-flex items-center gap-1.5 text-sm font-bold tracking-wide hover:underline ${darkMode ? 'text-[#58A6FF]' : 'text-[#0C66E4]'}`}
                                      >
                                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest ${darkMode ? 'bg-[rgba(56,139,253,0.15)] text-[#58A6FF]' : 'bg-[#E9F2FF] text-[#0747A6]'}`}>Epic</span>
                                        {epicKey}
                                        <ExternalLink className="w-3 h-3 opacity-60" />
                                      </a>
                                    ) : (
                                      <span className={`text-sm font-bold tracking-wide ${darkMode ? 'text-[#58A6FF]' : 'text-[#0C66E4]'}`}>
                                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mr-2 ${darkMode ? 'bg-[rgba(56,139,253,0.15)] text-[#58A6FF]' : 'bg-[#E9F2FF] text-[#0747A6]'}`}>Epic</span>
                                        {epicKey}
                                      </span>
                                    )}
                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${darkMode ? 'bg-[#30363D] text-[#8B949E]' : 'bg-[#DFE1E6] text-[#5E6C84]'}`}>
                                      {reqs.length} {reqs.length === 1 ? 'story' : 'stories'}
                                    </span>
                                  </div>
                                  {em.totalScenarios > 0 && (
                                    <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold ${
                                      em.scenarioPassPct === 100
                                        ? (darkMode ? 'bg-[rgba(63,185,80,0.15)] text-[#3FB950]' : 'bg-[#E3FCEF] text-[#00875A]')
                                        : em.scenarioPassPct >= 50
                                          ? (darkMode ? 'bg-[rgba(210,153,34,0.15)] text-[#D29922]' : 'bg-[#FFF7D6] text-[#B65C00]')
                                          : (darkMode ? 'bg-[rgba(248,81,73,0.15)] text-[#F85149]' : 'bg-[#FFEBE6] text-[#C9372C]')
                                    }`}>
                                      {em.scenarioPassPct}% passing
                                    </span>
                                  )}
                                </div>

                                {/* Row 2: Metrics — Progress bar + stats */}
                                {em.totalScenarios > 0 ? (
                                  <div className="space-y-2">
                                    {/* Full-width progress bar */}
                                    <div className={`w-full h-2 rounded-full overflow-hidden ${darkMode ? 'bg-[#30363D]' : 'bg-[#DFE1E6]'}`}>
                                      <div
                                        className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-500"
                                        style={{ width: `${em.scenarioPassPct}%` }}
                                      />
                                    </div>

                                    {/* Stats row */}
                                    <div className="flex flex-wrap items-center gap-3">
                                      {/* Scenario stats */}
                                      <div className="flex items-center gap-2">
                                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(56,139,253,0.1)] border-[rgba(56,139,253,0.3)] text-[#58A6FF]' : 'bg-indigo-500/10 border-indigo-500/20 text-[#0C66E4]'}`}>
                                          <Activity className="w-3 h-3" />
                                          {em.totalScenarios} scenario{em.totalScenarios !== 1 ? 's' : ''}
                                        </span>
                                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(63,185,80,0.1)] border-[rgba(63,185,80,0.3)] text-[#3FB950]' : 'bg-green-500/10 border-green-500/20 text-[#00875A]'}`}>
                                          <ShieldCheck className="w-3 h-3" />
                                          {em.passedScenariosStrict} passing
                                        </span>
                                        {em.failedScenarios > 0 && (
                                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(248,81,73,0.1)] border-[rgba(248,81,73,0.3)] text-[#F85149]' : 'bg-red-500/10 border-red-500/20 text-[#C9372C]'}`}>
                                            <XCircle className="w-3 h-3" />
                                            {em.failedScenarios} failing
                                          </span>
                                        )}
                                        {em.pendingScenarios > 0 && (
                                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(210,153,34,0.1)] border-[rgba(210,153,34,0.3)] text-[#D29922]' : 'bg-yellow-500/10 border-yellow-500/20 text-[#B65C00]'}`}>
                                            <Clock className="w-3 h-3" />
                                            {em.pendingScenarios} pending
                                          </span>
                                        )}
                                      </div>

                                      {/* Divider */}
                                      <span className={`text-[10px] ${darkMode ? 'text-[#484F58]' : 'text-[#C1C7D0]'}`}>│</span>

                                      {/* Test case stats */}
                                      <div className="flex items-center gap-2">
                                        {em.total > 0 ? (
                                          <>
                                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(56,139,253,0.1)] border-[rgba(56,139,253,0.3)] text-[#58A6FF]' : 'bg-indigo-500/10 border-indigo-500/20 text-[#0C66E4]'}`}>
                                              <ListChecks className="w-3 h-3" />
                                              {em.total} test case{em.total !== 1 ? 's' : ''}
                                            </span>
                                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(63,185,80,0.1)] border-[rgba(63,185,80,0.3)] text-[#3FB950]' : 'bg-green-500/10 border-green-500/20 text-[#00875A]'}`}>
                                              <CheckCircle2 className="w-3 h-3" />
                                              {em.passed} passed
                                            </span>
                                            {em.failed > 0 && (
                                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(248,81,73,0.1)] border-[rgba(248,81,73,0.3)] text-[#F85149]' : 'bg-red-500/10 border-red-500/20 text-[#C9372C]'}`}>
                                                <XCircle className="w-3 h-3" />
                                                {em.failed} failed
                                              </span>
                                            )}
                                            {em.notDone > 0 && (
                                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${darkMode ? 'bg-[rgba(210,153,34,0.1)] border-[rgba(210,153,34,0.3)] text-[#D29922]' : 'bg-yellow-500/10 border-yellow-500/20 text-[#B65C00]'}`}>
                                                <Clock className="w-3 h-3" />
                                                {em.notDone} not done
                                              </span>
                                            )}
                                          </>
                                        ) : (
                                          <span className={`text-[10px] italic ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`}>No test cases yet</span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <span className={`text-[10px] italic ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`}>No scenarios generated yet</span>
                                )}
                              </div>
                            </td>
                          </tr>
                          {reqs.map((req) => {
                            const reqScenarios = rtm.scenarios?.filter(s => s.parentReq === req.reqId) || [];
                            const totalTestCases = reqScenarios.reduce((n, s) => n + (s.testCases?.length || 0), 0);
                            const passedTestCases = reqScenarios.reduce((n, s) => n + (s.testCases?.filter(tc => tc.status === 'pass').length || 0), 0);
                            const failedTestCases = reqScenarios.reduce((n, s) => n + (s.testCases?.filter(tc => tc.status === 'fail').length || 0), 0);

                            if (reqScenarios.length === 0) {
                              return (
                                <tr key={req.reqId} className="hover:bg-[#F1F2F4]/10 transition-colors group">
                                  <td className="px-3 py-2 align-top w-1/4 border-r border-[#DFE1E6]">
                                      <div className="font-semibold text-[#172B4D] mb-1">{req.reqId}</div>
                                      <div className="text-sm text-[#5E6C84] line-clamp-3">{req.description}</div>
                                      {req.lastSyncedAt && (
                                        <span className="inline-flex mt-2 px-2 py-1 bg-indigo-500/10 border border-indigo-500/20 text-[10px] font-medium rounded text-indigo-300" title={`Last synced: ${new Date(req.lastSyncedAt).toLocaleString()}`}>
                                          Synced {new Date(req.lastSyncedAt).toLocaleDateString()}
                                        </span>
                                      )}
                                      <div className="mt-2">
                                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-[#DFE1E6]/30 border border-[#DFE1E6] text-xs font-medium rounded text-[#8993A4]">
                                          <Clock className="w-3 h-3" /> Awaiting PR
                                        </span>
                                      </div>
                                  </td>
                                  <td colSpan={2} className="px-3 py-2">
                                      <div className="text-sm text-[#8993A4] italic py-3 text-center bg-[#F1F2F4]/30 rounded border border-dashed border-[#C1C7D0]">No scenarios generated yet.</div>
                                  </td>
                                </tr>
                              );
                            }

                            return (
                              <React.Fragment key={req.reqId}>
                                {reqScenarios.map((scen, index) => {
                                  const typeBadge = {
                                    'Happy Path': 'bg-green-500/15 border-green-500/30 text-[#00875A]',
                                    'Negative':   'bg-red-500/15 border-red-500/30 text-[#C9372C]',
                                    'Edge Case':  'bg-amber-500/15 border-amber-500/30 text-[#B65C00]',
                                    'Boundary':   'bg-orange-500/15 border-orange-500/30 text-orange-300',
                                  }[scen.type] || 'bg-gray-500/15 border-gray-500/30 text-[#5E6C84]';

                                  const tcs = scen.testCases || [];
                                  const scenDot = scenarioHeaderDotMeta(tcs, scen.execStatus, darkMode);

                                  return (
                                    <tr key={scen.id} className="hover:bg-[#F1F2F4]/10 transition-colors group border-b border-[#DFE1E6]/50">
                                      {index === 0 && (
                                        <td rowSpan={reqScenarios.length} className={`px-3 py-2 align-top w-1/4 border-r ${darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]'}`}>
                                          <div className={`font-semibold mb-1 ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>{req.reqId}</div>
                                          <div className={`text-sm line-clamp-3 mb-2 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>{req.description}</div>
                                          
                                          {/* Trace Metrics moved to the Req column */}
                                          <div className="space-y-1 mb-1.5">
                                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-500/10 border border-indigo-500/20 text-xs font-medium rounded text-indigo-300 w-full justify-center">
                                              <ListChecks className="w-3 h-3" /> {totalTestCases} test case{totalTestCases !== 1 ? 's' : ''}
                                            </span>
                                            {passedTestCases > 0 && (
                                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-500/10 border border-green-500/20 text-[10px] font-medium rounded text-[#00875A] w-full justify-center">
                                                <CheckCircle2 className="w-3 h-3" /> {passedTestCases}/{totalTestCases} passed
                                              </span>
                                            )}
                                            {failedTestCases > 0 && (
                                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-red-500/10 border border-red-500/20 text-[10px] font-medium rounded text-[#C9372C] w-full justify-center">
                                                <XCircle className="w-3 h-3" /> {failedTestCases} failed
                                              </span>
                                            )}
                                          </div>
                                          
                                          {req.lastSyncedAt && (
                                            <span className={`inline-flex px-2 py-1 text-[10px] font-medium rounded border ${darkMode ? 'bg-[rgba(56,139,253,0.1)] border-[rgba(56,139,253,0.3)] text-[#58A6FF]' : 'bg-indigo-500/10 border-indigo-500/20 text-indigo-300'}`} title={`Last synced: ${new Date(req.lastSyncedAt).toLocaleString()}`}>
                                              Synced {new Date(req.lastSyncedAt).toLocaleDateString()}
                                            </span>
                                          )}
                                        </td>
                                      )}
                                      
                                      <td className={`px-3 py-2 align-top w-[35%] border-r ${darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]'}`}>
                                        <div 
                                          onClick={() => openScenarioDetails(scen)}
                                          className={`p-2 rounded border transition cursor-pointer flex flex-col group/card h-full ${
                                            darkMode 
                                              ? 'bg-[#1C2333] border-[#30363D] hover:bg-[#242C3D]' 
                                              : 'bg-[#FFFFFF] hover:bg-[#F1F2F4] border-[#DFE1E6]'
                                          }`}
                                        >
                                          <div className="flex justify-between items-start mb-1.5">
                                              <span className={`text-xs font-mono truncate pr-2 ${darkMode ? 'text-[#58A6FF]' : 'text-indigo-600'}`} title={scen.id}>{scen.id}</span>
                                              <div className="flex items-center flex-shrink-0">
                                                  <div className={`w-2 h-2 rounded-full mr-1 ${scenDot.cls}`} title={scenDot.label} />
                                              </div>
                                          </div>
                                          <span className={`self-start text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border mb-1.5 ${typeBadge}`}>
                                            {scen.type || 'Scenario'}
                                          </span>
                                          <p className={`text-xs mb-1.5 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>{scen.description}</p>
                                          
                                          <div className="mt-auto flex justify-between items-center pt-1">
                                              <span className={`text-[10px] font-medium ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`}>
                                                  {tcs.length} cases
                                              </span>
                                              <ChevronRight className={`w-4 h-4 transition-colors ${darkMode ? 'text-[#484F58] group-hover/card:text-[#58A6FF]' : 'text-[#8993A4] group-hover/card:text-indigo-500'}`} />
                                          </div>
                                        </div>
                                      </td>
                                      
                                      <td className="px-3 py-2 align-top w-[40%]">
                                        {tcs.length > 0 ? (
                                          <div className="space-y-1">
                                            {tcs.map(tc => {
                                              const s = normTcStatus(tc.status);
                                              const tcChip = testCaseChipClasses(tc, darkMode);

                                              return (
                                                <div
                                                  key={tc.testCaseId}
                                                  onClick={() => openTestCaseDetails(tc, scen)}
                                                  className={`cursor-pointer p-1.5 rounded border transition-colors ${tcChip}`}
                                                >
                                                  <div className="flex items-center justify-between mb-0.5">
                                                    <span className="text-[10px] font-mono truncate pr-1">{tc.testCaseId}</span>
                                                    <div className="flex items-center gap-1 flex-shrink-0">
                                                      {tc.version > 1 && (
                                                        <span className={`text-[9px] px-1.5 rounded border ${darkMode ? 'bg-[rgba(56,139,253,0.1)] text-[#58A6FF] border-[#58A6FF]/30' : 'bg-blue-500/10 text-blue-600 border-blue-500/20'}`}>v{tc.version}</span>
                                                      )}
                                                      {s === 'pass' && <CheckCircle2 className={`w-3 h-3 ${darkMode ? 'text-[#3FB950]' : 'text-[#00875A]'}`} />}
                                                      {s === 'fail' && <XCircle className={`w-3 h-3 ${darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'}`} />}
                                                      {s === 'running' && <Loader className={`w-3 h-3 animate-spin ${darkMode ? 'text-[#D29922]' : 'text-[#B65C00]'}`} />}
                                                      {s === 'healing' && <RefreshCw className={`w-3 h-3 animate-pulse ${darkMode ? 'text-[#58A6FF]' : 'text-[#0C66E4]'}`} />}
                                                      {(!s || s === 'pending') && <Clock className={`w-3 h-3 ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`} />}
                                                      <ChevronRight className="w-3 h-3 opacity-50" />
                                                    </div>
                                                  </div>
                                                  <p className="text-xs opacity-90 line-clamp-2">{tc.title}</p>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        ) : (
                                          <span className={`text-xs italic ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`}>No test cases generated</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </React.Fragment>
                            );
                          })}
                        </React.Fragment>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan="3" className="px-6 py-12 text-center text-[#8993A4]">
                            No requirements found. Click "Sync Jira" to pull stories in "Selected for Development" and generate test scenarios.
                        </td>
                      </tr>
                    )}
                </tbody>
            </table>
          </div>
          <div className={`px-4 py-3 border-t flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] ${darkMode ? 'border-[#30363D] text-[#8B949E]' : 'border-[#DFE1E6] text-[#5E6C84]'}`}>
            <span className="font-semibold uppercase tracking-wide">Test case status</span>
            <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${darkMode ? 'bg-[#6E7681]' : 'bg-[#8993A4]'}`} /> Pending</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-yellow-500" /> Running (sandbox)</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500" /> Healing (LLM)</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-500" /> Pass</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" /> Fail</span>
          </div>
        </div>
      )}

      {/* Pipeline Runs View */}
      {activeTab === 'runs' && (
        <div className="bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg overflow-hidden p-4">
          <div className="flex items-center gap-2 mb-6">
            <Activity className="w-5 h-5 text-blue-400" />
            <h3 className="text-lg font-bold text-[#172B4D]">Execution History</h3>
          </div>
          
          {projectRuns.length === 0 ? (
            <div className="text-center py-12 bg-[#F1F2F4]/30 rounded-lg border border-dashed border-[#C1C7D0]">
              <PlayCircle className="w-8 h-8 text-[#8993A4] mx-auto mb-3" />
              <p className="text-[#5E6C84]">No QA pipelines have run for this project yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {projectRuns.map((run) => {
                // Extract compact summary from events array
                const summaryEvent = [...(run.events || [])].reverse().find(e => e.type === 'run_summary_updated');
                const summary = summaryEvent?.data || {};
                const isRunning = run.status === 'running';
                const isFailed = run.status === 'failed' || run.status === 'error';
                const isCompleted = run.status === 'completed';

                return (
                  <div key={run.runId} className="bg-[#FFFFFF] border border-[#DFE1E6] rounded-lg px-4 py-3 flex items-center justify-between gap-4 group hover:bg-[#F1F2F4] transition-colors">
                    {/* Left: status icon + run ID + timestamp */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0">
                        {isCompleted ? <CheckCircle2 className="w-4 h-4 text-green-500" /> :
                         isFailed    ? <XCircle className="w-4 h-4 text-red-500" /> :
                                       <Loader className="w-4 h-4 text-blue-400 animate-spin" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-mono text-[#172B4D]">#{run.runId.substring(0, 8)}</span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${isCompleted ? 'bg-green-500/15 text-[#00875A]' : isFailed ? 'bg-red-500/15 text-[#C9372C]' : 'bg-blue-500/15 text-blue-300'}`}>
                            {isCompleted ? 'Passed' : isFailed ? 'Failed' : 'Running'}
                          </span>
                        </div>
                        <span className="text-[10px] text-[#8993A4] flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3" />
                          {new Date(run.createdAt || Date.now()).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* Middle: mini live counters */}
                    <div className="hidden md:flex items-center gap-3 text-[11px]">
                      {summary.scenarioCount > 0 && (
                        <span className="flex items-center gap-1 text-[#5E6C84]">
                          <Activity className="w-3 h-3" />{summary.scenarioCount} scenario{summary.scenarioCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      {summary.testCaseCount > 0 && (
                        <span className="flex items-center gap-1 text-[#5E6C84]">
                          <ListChecks className="w-3 h-3" />{summary.testCaseCount} case{summary.testCaseCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      {summary.passedCount > 0 && (
                        <span className="flex items-center gap-1 text-[#00875A]">
                          <CheckCircle2 className="w-3 h-3" />{summary.passedCount} pass
                        </span>
                      )}
                      {summary.failedCount > 0 && (
                        <span className="flex items-center gap-1 text-[#C9372C]">
                          <XCircle className="w-3 h-3" />{summary.failedCount} fail
                        </span>
                      )}
                      {summary.retryCount > 0 && (
                        <span className="flex items-center gap-1 text-orange-400">
                          <RefreshCw className="w-3 h-3" />{summary.retryCount} retry
                        </span>
                      )}
                    </div>

                    {/* Right: actions */}
                    <div className="flex items-center gap-2 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={() => navigate(`/projects/${projectId}/run/${run.runId}/scripts`)}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-medium transition-colors"
                      >
                        View Details
                      </button>
                      <button
                        onClick={(e) => handleDeleteRun(run.runId, e)}
                        className="p-1.5 text-[#8993A4] hover:text-[#C9372C] hover:bg-red-400/10 rounded transition-colors"
                        title="Delete run and all test cases"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Documents View */}
      {activeTab === 'docs' && (
        <div className="bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-400" />
              <h3 className="text-lg font-bold text-[#172B4D]">Context Documents</h3>
            </div>
            <div>
              <input
                type="file"
                id="doc-upload"
                multiple
                accept=".pdf,.docx,.txt"
                className="hidden"
                onChange={handleUploadDocument}
                disabled={uploadingDocs}
              />
              <label 
                htmlFor="doc-upload"
                className={`flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded cursor-pointer text-sm font-medium transition-colors ${uploadingDocs ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {uploadingDocs ? <Loader className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                Upload Document
              </label>
            </div>
          </div>
          
          <div className="mb-4 text-sm text-[#5E6C84]">
            Upload PDF, DOCX, or TXT files. The text will be extracted and passed to the LLM during Test Scenario generation to provide additional context.
          </div>

          {documents.length === 0 ? (
            <div className="text-center py-12 bg-[#F1F2F4]/30 rounded border border-dashed border-[#C1C7D0]">
              <FileText className="w-8 h-8 text-[#8993A4] mx-auto mb-3" />
              <p className="text-[#5E6C84]">No context documents uploaded for this project yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map((doc, idx) => (
                <div key={idx} className="bg-[#FFFFFF] border border-[#DFE1E6] rounded p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-500/10 rounded">
                      <FileText className="w-5 h-5 text-indigo-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#172B4D]">{doc.originalName || doc.path.split(/[\\/]/).pop()}</p>
                      <p className="text-xs text-[#8993A4] mt-1">Uploaded {new Date(doc.uploadedAt).toLocaleString()}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => handleDeleteDocument(doc.path)}
                    className="p-2 text-[#5E6C84] hover:text-[#C9372C] hover:bg-red-400/10 rounded transition-colors"
                    title="Remove document"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Slide-In Details Panel */}
      <div className={`fixed inset-y-0 right-0 w-full max-w-[560px] bg-[#F4F5F7] border-l border-[#DFE1E6] shadow-[0_0_40px_rgba(0,0,0,0.5)] transform transition-transform duration-300 ease-in-out z-40 overflow-y-auto ${isPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}>

          {/* SCENARIO PANEL */}
          {isPanelOpen && panelMode === 'scenario' && selectedItem && (
              <div className="h-full flex flex-col">
                  <div className="flex justify-between items-start p-6 border-b border-[#DFE1E6] bg-[#F4F5F7] sticky top-0 z-10">
                      <div className="pr-4">
                          <p className="text-sm font-medium text-indigo-400 font-mono mb-1">{selectedItem.id}</p>
                          <h2 className="text-xl font-bold text-[#172B4D] leading-tight">Scenario Detail</h2>
                          <div className="flex items-center mt-3 text-sm">
                            {(() => {
                              const tcs = selectedItem.testCases || [];
                              const ex = normTcStatus(selectedItem.execStatus);
                              if (ex === 'fail') {
                                return <><AlertTriangle className="w-4 h-4 text-red-500 mr-2"/><span className="text-[#C9372C] font-medium">Failed</span></>;
                              }
                              if (tcs.some((t) => normTcStatus(t.status) === 'healing')) {
                                return <><RefreshCw className="w-4 h-4 text-blue-500 mr-2 animate-pulse"/><span className="text-[#0C66E4] font-medium">Healing (LLM repair)</span></>;
                              }
                              if (tcs.some((t) => normTcStatus(t.status) === 'running')) {
                                return <><Loader className="w-4 h-4 text-amber-500 mr-2 animate-spin"/><span className="text-[#B65C00] font-medium">Running in sandbox</span></>;
                              }
                              if (ex === 'pass') {
                                return <><ShieldCheck className="w-4 h-4 text-green-500 mr-2"/><span className="text-[#00875A] font-medium">Passed</span></>;
                              }
                              return <><Clock className="w-4 h-4 text-[#8993A4] mr-2"/><span className="text-[#5E6C84] font-medium">Pending execution</span></>;
                            })()}
                          </div>
                      </div>
                      <button onClick={closePanel} className="text-[#5E6C84] hover:text-[#172B4D] bg-[#F1F2F4] hover:bg-[#DFE1E6] p-2 rounded-full transition-colors flex-shrink-0 mt-1">
                          <X className="w-5 h-5"/>
                      </button>
                  </div>
                  <div className="p-6 space-y-6 flex-1">
                      <div>
                          <h4 className="text-xs uppercase tracking-widest font-bold text-[#8993A4] mb-2 flex items-center"><span className="w-1 h-4 bg-indigo-500 rounded mr-2"/>Description</h4>
                          <p className="text-[#5E6C84] text-sm leading-relaxed bg-[#FFFFFF] p-4 rounded border border-[#DFE1E6]">{selectedItem.description}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                          <div className="bg-[#FFFFFF] p-3 rounded border border-[#DFE1E6]"><span className="text-xs text-[#8993A4] block mb-1">Type</span><span className="text-sm font-medium text-[#172B4D]">{selectedItem.type || '—'}</span></div>
                          <div className="bg-[#FFFFFF] p-3 rounded border border-[#DFE1E6]"><span className="text-xs text-[#8993A4] block mb-1">Priority</span><span className="text-sm font-medium text-[#172B4D]">{selectedItem.priority || '—'}</span></div>
                      </div>

                      {/* Test Cases Summary inside scenario panel */}
                      {(selectedItem.testCases?.length > 0) && (
                          <div>
                              <h4 className="text-xs uppercase tracking-widest font-bold text-[#8993A4] mb-2 flex items-center"><span className="w-1 h-4 bg-green-500 rounded mr-2"/>Test Cases ({selectedItem.testCases.length})</h4>
                              <div className="space-y-2">
                                  {selectedItem.testCases.map(tc => (
                                      <div key={tc.testCaseId}
                                          onClick={() => openTestCaseDetails(tc, selectedItem)}
                                          className="cursor-pointer flex items-center justify-between p-3 bg-[#FFFFFF] hover:bg-[#F1F2F4] rounded border border-[#DFE1E6] transition-colors">
                                          <div>
                                              <span className="text-xs font-mono text-indigo-400">{tc.testCaseId}</span>
                                              {tc.version > 1 && <span className="ml-2 text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{tc.version}</span>}
                                              <p className="text-xs text-[#5E6C84] mt-0.5">{tc.title}</p>
                                          </div>
                                          <div className="flex items-center gap-2 flex-shrink-0">
                                              {normTcStatus(tc.status) === 'pass' && <CheckCircle2 className="w-4 h-4 text-[#00875A]"/>}
                                              {normTcStatus(tc.status) === 'fail' && <XCircle className="w-4 h-4 text-[#C9372C]"/>}
                                              {normTcStatus(tc.status) === 'running' && <Loader className="w-4 h-4 text-amber-500 animate-spin"/>}
                                              {normTcStatus(tc.status) === 'healing' && <RefreshCw className="w-4 h-4 text-[#0C66E4] animate-pulse"/>}
                                              {(!normTcStatus(tc.status) || normTcStatus(tc.status) === 'pending') && <Clock className="w-4 h-4 text-[#8993A4]"/>}
                                              <ChevronRight className="w-4 h-4 text-[#8993A4]"/>
                                          </div>
                                      </div>
                                  ))}
                              </div>
                          </div>
                      )}

                      {selectedItem.lastPRTested && (
                          <div>
                              <h4 className="text-xs uppercase tracking-widest font-bold text-[#8993A4] mb-2 flex items-center"><span className="w-1 h-4 bg-blue-500 rounded mr-2"/>Last PR Trace</h4>
                              <div className="bg-blue-900/10 border border-blue-900 p-3 rounded"><span className="text-xs text-blue-400 block mb-1">Run ID</span><span className="text-sm text-blue-300 font-mono">{selectedItem.lastPRTested}</span></div>
                          </div>
                      )}
                  </div>
              </div>
          )}

          {/* TEST CASE PANEL */}
          {isPanelOpen && panelMode === 'testcase' && selectedTestCase && (
              <div className="h-full flex flex-col">
                  <div className="flex justify-between items-start p-6 border-b border-[#DFE1E6] bg-[#F4F5F7] sticky top-0 z-10">
                      <div className="pr-4 min-w-0">
                          <p className="text-[10px] text-[#8993A4] mb-1">
                              {selectedTestCase.parentScenario?.id} → <span className="text-indigo-400 font-mono">{selectedTestCase.testCaseId}</span>
                              {selectedTestCase.version > 1 && <span className="ml-2 text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{selectedTestCase.version}</span>}
                          </p>
                          <h2 className="text-lg font-bold text-[#172B4D] leading-tight">{selectedTestCase.title}</h2>
                          <div className="flex items-center mt-2 text-xs gap-3">
                              {normTcStatus(selectedTestCase.status) === 'pass' && <span className="flex items-center gap-1 text-[#00875A]"><CheckCircle2 className="w-3.5 h-3.5"/>Passed</span>}
                              {normTcStatus(selectedTestCase.status) === 'fail' && <span className="flex items-center gap-1 text-[#C9372C]"><XCircle className="w-3.5 h-3.5"/>Failed</span>}
                              {normTcStatus(selectedTestCase.status) === 'running' && <span className="flex items-center gap-1 text-[#B65C00]"><Loader className="w-3.5 h-3.5 animate-spin"/>Running</span>}
                              {normTcStatus(selectedTestCase.status) === 'healing' && <span className="flex items-center gap-1 text-[#0C66E4]"><RefreshCw className="w-3.5 h-3.5 animate-pulse"/>Healing</span>}
                              {(!normTcStatus(selectedTestCase.status) || normTcStatus(selectedTestCase.status) === 'pending') && <span className="flex items-center gap-1 text-[#5E6C84]"><Clock className="w-3.5 h-3.5"/>Pending</span>}
                              {selectedTestCase.language && <span className="flex items-center gap-1 text-[#5E6C84]"><Code2 className="w-3.5 h-3.5"/>{selectedTestCase.language}</span>}
                          </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                          <button onClick={() => { setPanelMode('scenario'); setSelectedItem(selectedTestCase.parentScenario); }} className="text-[#5E6C84] hover:text-indigo-400 bg-[#F1F2F4] hover:bg-[#DFE1E6] p-2 rounded-full transition-colors" title="Back to scenario">
                              <ChevronRight className="w-4 h-4 rotate-180"/>
                          </button>
                          <button onClick={closePanel} className="text-[#5E6C84] hover:text-[#172B4D] bg-[#F1F2F4] hover:bg-[#DFE1E6] p-2 rounded-full transition-colors">
                              <X className="w-5 h-5"/>
                          </button>
                      </div>
                  </div>

                  {/* Tab bar */}
                  <div className="flex border-b border-[#DFE1E6] bg-[#F4F5F7]">
                      {[['steps','Steps','ListChecks'], ['script','Test Script','Code2'], ['data','Test Data','Database']].map(([key, label, _]) => (
                          <button key={key} onClick={() => setTcPanelTab(key)}
                              className={`px-5 py-3 text-xs font-medium border-b-2 transition-colors ${tcPanelTab === key ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-[#8993A4] hover:text-[#5E6C84]'}`}>
                              {label}
                          </button>
                      ))}
                  </div>

                  <div className="p-6 flex-1 overflow-auto">
                      {/* Steps Tab */}
                      {tcPanelTab === 'steps' && (
                          <div className="space-y-3">
                              {(selectedTestCase.steps || []).length === 0
                                  ? <p className="text-sm text-[#8993A4] italic">No steps recorded.</p>
                                  : (selectedTestCase.steps || []).map((step, i) => (
                                      <div key={i} className="bg-[#FFFFFF] border border-[#DFE1E6] rounded p-3">
                                          <div className="flex items-start gap-3">
                                              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[10px] flex items-center justify-center font-bold">{i + 1}</span>
                                              <div className="min-w-0">
                                                  <p className="text-xs text-[#172B4D] font-medium mb-1">{step.action}</p>
                                                  {step.expectedResult && (
                                                      <p className="text-[10px] text-[#8993A4] italic">Expected: {step.expectedResult}</p>
                                                  )}
                                              </div>
                                          </div>
                                      </div>
                                  ))
                              }
                              {selectedTestCase.codeFiles?.length > 0 && (
                                  <div className="mt-4">
                                      <h5 className="text-xs text-[#8993A4] uppercase tracking-wider mb-2 flex items-center gap-1"><GitBranch className="w-3 h-3"/>Covers Files</h5>
                                      <div className="space-y-1">
                                          {selectedTestCase.codeFiles.map(f => (
                                              <span key={f} className="block text-[11px] font-mono text-[#5E6C84] bg-[#F1F2F4] px-2 py-1 rounded">{f}</span>
                                          ))}
                                      </div>
                                  </div>
                              )}
                          </div>
                      )}

                      {/* Script Tab */}
                      {tcPanelTab === 'script' && (
                          <div>
                              {selectedTestCase.testScript
                                  ? <pre className="text-xs text-[#5E6C84] bg-[#FAFBFC] p-4 rounded border border-[#DFE1E6] overflow-auto whitespace-pre-wrap font-mono leading-relaxed">{selectedTestCase.testScript}</pre>
                                  : <p className="text-sm text-[#8993A4] italic">No test script generated yet.</p>
                              }
                          </div>
                      )}

                      {/* Data Tab */}
                      {tcPanelTab === 'data' && (
                          <div>
                              {selectedTestCase.testData && Object.keys(selectedTestCase.testData).length > 0
                                  ? <pre className="text-xs text-[#5E6C84] bg-[#FAFBFC] p-4 rounded border border-[#DFE1E6] overflow-auto whitespace-pre-wrap font-mono">{JSON.stringify(selectedTestCase.testData, null, 2)}</pre>
                                  : <p className="text-sm text-[#8993A4] italic">No test data recorded.</p>
                              }
                          </div>
                      )}
                  </div>

                  {/* Footer meta */}
                  <div className="px-6 py-3 border-t border-[#DFE1E6] bg-[#F4F5F7] text-[10px] text-[#8993A4] flex items-center justify-between">
                      <span>Created {selectedTestCase.createdAt ? new Date(selectedTestCase.createdAt).toLocaleString() : '—'}</span>
                      {selectedTestCase.healAttempts > 0 && <span className="flex items-center gap-1 text-orange-400"><RefreshCw className="w-3 h-3"/>{selectedTestCase.healAttempts} heal attempt{selectedTestCase.healAttempts !== 1 ? 's' : ''}</span>}
                      {selectedTestCase.prUrl && <a href={selectedTestCase.prUrl} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline truncate max-w-[160px]" title={selectedTestCase.prUrl}>PR ↗</a>}
                  </div>
              </div>
          )}
      </div>

      {/* Slide-In Overlay Background */}
      {isPanelOpen && (
          <div 
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 transition-opacity" 
            onClick={closePanel}
          />
      )}
    </div>
  );
}

export default ProjectDashboard;
