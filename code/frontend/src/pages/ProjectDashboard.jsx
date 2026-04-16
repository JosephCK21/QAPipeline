import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Activity, ShieldCheck, Bug, Clock, GitCommit, Search, ChevronRight, ChevronDown, X, AlertTriangle, Settings, CheckCircle2, XCircle, Loader, PlayCircle, FileText, Upload, Trash2, Code2, Database, ListChecks, RefreshCw, GitBranch } from 'lucide-react';
import { useAppContext } from '../App';

function ProjectDashboard() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { showToast, refreshKey } = useAppContext();
  
  const [project, setProject] = useState(null);
  const [rtm, setRtm] = useState({ requirements: [], scenarios: [] });
  const [rtmStats, setRtmStats] = useState({ totalReqs: 0, testedScenarios: 0, coverage: 0, totalScenarios: 0 });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState('rtm');
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
    return <div className="p-8 text-gray-400">Loading project dashboard...</div>;
  }

  return (
    <div className="space-y-6 relative overflow-hidden h-full">
      {/* Header Info */}
      <div className="flex justify-between items-start bg-gray-900 border border-gray-800 p-6 rounded-lg">
        <div>
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400 mb-2">
            {project?.name || 'Project Dashboard'}
          </h1>
          <div className="flex space-x-4 text-sm text-gray-400">
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
              className="flex items-center px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-md border border-gray-700 transition-colors text-sm font-medium"
            >
              <Settings className="w-4 h-4 mr-2" />
              Project Settings
            </button>
          </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 p-4 rounded-lg flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm">Feature Coverage</p>
            <p className="text-2xl font-bold text-white">{rtmStats.coverage}%</p>
          </div>
          <div className="p-3 bg-blue-500/10 rounded-full"><ShieldCheck className="text-blue-400 w-6 h-6" /></div>
        </div>
        <div className="bg-gray-900 border border-gray-800 p-4 rounded-lg flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm">Active Requirements</p>
            <p className="text-2xl font-bold text-white">{rtmStats.totalReqs}</p>
          </div>
          <div className="p-3 bg-indigo-500/10 rounded-full"><Activity className="text-indigo-400 w-6 h-6" /></div>
        </div>
        <div className="bg-gray-900 border border-gray-800 p-4 rounded-lg flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm">Tested Scenarios</p>
            <p className="text-2xl font-bold text-white">{rtmStats.testedScenarios} / {rtmStats.totalScenarios}</p>
          </div>
          <div className="p-3 bg-green-500/10 rounded-full"><Bug className="text-green-400 w-6 h-6" /></div>
        </div>
        <div className="bg-gray-900 border border-gray-800 p-4 rounded-lg flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm">Pending Execution</p>
            <p className="text-2xl font-bold text-white">{Math.max(0, rtmStats.totalScenarios - rtmStats.testedScenarios)}</p>
          </div>
          <div className="p-3 bg-yellow-500/10 rounded-full"><Clock className="text-yellow-400 w-6 h-6" /></div>
        </div>
      </div>

      <div className="border-b border-gray-800">
        <nav className="-mb-px flex space-x-8">
          <button onClick={() => setActiveTab('rtm')} className={`${activeTab === 'rtm' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-300'} whitespace-nowrap pb-4 px-1 border-b-2 font-medium`}>Traceability Matrix</button>
          <button onClick={() => setActiveTab('runs')} className={`${activeTab === 'runs' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-300'} whitespace-nowrap pb-4 px-1 border-b-2 font-medium`}>Pipeline Runs</button>
          <button onClick={() => setActiveTab('docs')} className={`${activeTab === 'docs' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-300'} whitespace-nowrap pb-4 px-1 border-b-2 font-medium`}>Context Documents</button>
        </nav>
      </div>

      {/* RTM View */}
      {activeTab === 'rtm' && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-gray-800 flex justify-between items-center">
             <div className="relative w-64">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-4 w-4 text-gray-500" />
                </div>
                <input
                  type="text"
                  placeholder="Search requirements..."
                  className="block w-full pl-10 pr-3 py-2 border border-gray-700 rounded-md leading-5 bg-gray-800 text-gray-300 placeholder-gray-500 focus:outline-none focus:bg-gray-800 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
             </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y border-collapse divide-gray-800">
                <thead className="bg-[#1A1A24]">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider w-1/4">Requirement</th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Test Scenarios</th>
                    <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider w-[140px]">Test Cases</th>
                  </tr>
                </thead>
                <tbody className="bg-gray-900 divide-y divide-gray-800">
                    {Object.keys(groupedRequirements).length > 0 ? (
                      Object.entries(groupedRequirements).map(([epicKey, reqs]) => (
                        <React.Fragment key={epicKey}>
                          <tr className="bg-[#1A1A2E]">
                            <td colSpan="3" className="px-6 py-2 text-xs font-bold text-indigo-400 uppercase tracking-wider border-b border-indigo-500/20">
                              Epic: {epicKey}
                            </td>
                          </tr>
                          {reqs.map((req) => {
                            const reqScenarios = rtm.scenarios?.filter(s => s.parentReq === req.reqId) || [];
                            const totalTestCases = reqScenarios.reduce((n, s) => n + (s.testCases?.length || 0), 0);
                            const passedTestCases = reqScenarios.reduce((n, s) => n + (s.testCases?.filter(tc => tc.status === 'pass').length || 0), 0);
                            const failedTestCases = reqScenarios.reduce((n, s) => n + (s.testCases?.filter(tc => tc.status === 'fail').length || 0), 0);
                            return (
                              <tr key={req.reqId} className="hover:bg-gray-800/10 transition-colors group">
                                <td className="px-6 py-4 align-top w-1/4 border-r border-gray-800">
                                    <div className="font-semibold text-gray-200 mb-1">{req.reqId}</div>
                                    <div className="text-sm text-gray-400 line-clamp-3">{req.description}</div>
                                    {req.lastSyncedAt && (
                                      <span className="inline-flex mt-2 px-2 py-1 bg-indigo-500/10 border border-indigo-500/20 text-[10px] font-medium rounded text-indigo-300" title={`Last synced: ${new Date(req.lastSyncedAt).toLocaleString()}`}>
                                        Synced {new Date(req.lastSyncedAt).toLocaleDateString()}
                                      </span>
                                    )}
                                </td>
                                <td className="px-6 py-4">
                                    {reqScenarios.length > 0 ? (
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                            {reqScenarios.map(scen => {
                                                const typeBadge = {
                                                  'Happy Path': 'bg-green-500/15 border-green-500/30 text-green-300',
                                                  'Negative':   'bg-red-500/15 border-red-500/30 text-red-300',
                                                  'Edge Case':  'bg-amber-500/15 border-amber-500/30 text-amber-300',
                                                  'Boundary':   'bg-orange-500/15 border-orange-500/30 text-orange-300',
                                                }[scen.type] || 'bg-gray-500/15 border-gray-500/30 text-gray-300';

                                                const isExpanded = !!expandedScenarios[scen.id];
                                                const tcs = scen.testCases || [];
                                                const tcPass = tcs.filter(tc => tc.status === 'pass').length;
                                                const tcFail = tcs.filter(tc => tc.status === 'fail').length;

                                                return (
                                                  <div key={scen.id} className="flex flex-col">
                                                    {/* Scenario Card */}
                                                    <div 
                                                      onClick={() => openScenarioDetails(scen)}
                                                      className="bg-[#1e1e2d] hover:bg-[#252538] cursor-pointer transition p-3 rounded border border-gray-700/50 flex flex-col group/card"
                                                    >
                                                      <div className="flex justify-between items-start mb-2">
                                                          <span className="text-xs font-mono text-indigo-400 truncate pr-2" title={scen.id}>{scen.id}</span>
                                                          <div className="flex items-center flex-shrink-0">
                                                              {scen.execStatus === 'pass' && <div className="w-2 h-2 rounded-full bg-green-500 mr-1 shadow-[0_0_8px_rgba(34,197,94,0.8)]" />}
                                                              {scen.execStatus === 'fail' && <div className="w-2 h-2 rounded-full bg-red-500 mr-1 shadow-[0_0_8px_rgba(239,68,68,0.8)]" />}
                                                              {(!scen.execStatus || scen.execStatus === 'pending') && <div className="w-2 h-2 rounded-full bg-yellow-500 mr-1 shadow-[0_0_5px_rgba(234,179,8,0.5)]" />}
                                                          </div>
                                                      </div>
                                                      <span className={`self-start text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border mb-2 ${typeBadge}`}>
                                                        {scen.type || 'Scenario'}
                                                      </span>
                                                      <p className="text-xs text-gray-300 line-clamp-3 mb-2">{scen.description}</p>
                                                      <div className="mt-auto flex justify-between items-center">
                                                          <div className="flex items-center gap-2">
                                                              {tcs.length > 0 && (
                                                                <button
                                                                  onClick={(e) => toggleScenarioExpand(scen.id, e)}
                                                                  className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-indigo-500/10 border border-indigo-500/30 rounded text-indigo-300 hover:bg-indigo-500/20 transition-colors"
                                                                  title={isExpanded ? 'Collapse test cases' : 'Expand test cases'}
                                                                >
                                                                  <ListChecks className="w-3 h-3" />
                                                                  {tcs.length} case{tcs.length !== 1 ? 's' : ''}
                                                                  {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                                                </button>
                                                              )}
                                                              {tcs.length === 0 && (
                                                                <span className="text-[10px] text-gray-600 italic">No test cases</span>
                                                              )}
                                                          </div>
                                                          <ChevronRight className="w-4 h-4 text-gray-600 group-hover/card:text-indigo-400 transition-colors" />
                                                      </div>
                                                    </div>

                                                    {/* Expandable Test Cases */}
                                                    {isExpanded && tcs.length > 0 && (
                                                      <div className="mt-1 ml-2 border-l-2 border-indigo-500/30 pl-2 space-y-1">
                                                        {tcs.map(tc => {
                                                          const tcStatusColor = tc.status === 'pass'
                                                            ? 'bg-green-500/10 border-green-500/30 text-green-300 hover:bg-green-500/20'
                                                            : tc.status === 'fail'
                                                            ? 'bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/20'
                                                            : 'bg-gray-700/30 border-gray-600/30 text-gray-400 hover:bg-gray-700/50';

                                                          return (
                                                            <div
                                                              key={tc.testCaseId}
                                                              onClick={() => openTestCaseDetails(tc, scen)}
                                                              className={`cursor-pointer p-2 rounded border transition-colors ${tcStatusColor}`}
                                                            >
                                                              <div className="flex items-center justify-between">
                                                                <span className="text-[10px] font-mono truncate pr-1">{tc.testCaseId}</span>
                                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                                  {tc.version > 1 && (
                                                                    <span className="text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{tc.version}</span>
                                                                  )}
                                                                  {tc.status === 'pass' && <CheckCircle2 className="w-3 h-3 text-green-400" />}
                                                                  {tc.status === 'fail' && <XCircle className="w-3 h-3 text-red-400" />}
                                                                  {(!tc.status || tc.status === 'pending') && <Clock className="w-3 h-3 text-yellow-400" />}
                                                                  <ChevronRight className="w-3 h-3 opacity-60" />
                                                                </div>
                                                              </div>
                                                              <p className="text-[10px] mt-0.5 opacity-80 line-clamp-1">{tc.title}</p>
                                                            </div>
                                                          );
                                                        })}
                                                      </div>
                                                    )}
                                                  </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="text-sm text-gray-500 italic py-6 text-center bg-gray-800/30 rounded border border-dashed border-gray-700">No scenarios generated yet.</div>
                                    )}
                                </td>
                                <td className="px-6 py-4 align-top w-[160px] border-l border-gray-800">
                                    {totalTestCases > 0 ? (
                                      <div className="space-y-1.5">
                                        <span className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-500/10 border border-indigo-500/20 text-xs font-medium rounded text-indigo-300 w-full justify-center">
                                          <ListChecks className="w-3 h-3" /> {totalTestCases} test case{totalTestCases !== 1 ? 's' : ''}
                                        </span>
                                        {passedTestCases > 0 && (
                                          <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-500/10 border border-green-500/20 text-[10px] font-medium rounded text-green-300 w-full justify-center">
                                            <CheckCircle2 className="w-3 h-3" /> {passedTestCases}/{totalTestCases} passed
                                          </span>
                                        )}
                                        {failedTestCases > 0 && (
                                          <span className="inline-flex items-center gap-1 px-2 py-1 bg-red-500/10 border border-red-500/20 text-[10px] font-medium rounded text-red-300 w-full justify-center">
                                            <XCircle className="w-3 h-3" /> {failedTestCases} failed
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-700/30 border border-gray-700/50 text-xs font-medium rounded text-gray-500">
                                        <Clock className="w-3 h-3" /> Awaiting PR
                                      </span>
                                    )}
                                </td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="3" className="px-6 py-12 text-center text-gray-500">
                            No requirements found. Click "Sync Jira" to pull stories in "Selected for Development" and generate test scenarios.
                        </td>
                      </tr>
                    )}
                </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pipeline Runs View */}
      {activeTab === 'runs' && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden p-4">
          <div className="flex items-center gap-2 mb-6">
            <Activity className="w-5 h-5 text-blue-400" />
            <h3 className="text-lg font-bold text-gray-200">Execution History</h3>
          </div>
          
          {projectRuns.length === 0 ? (
            <div className="text-center py-12 bg-gray-800/30 rounded-lg border border-dashed border-gray-700">
              <PlayCircle className="w-8 h-8 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400">No QA pipelines have run for this project yet.</p>
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
                  <div key={run.runId} className="bg-[#1e1e2d] border border-gray-800 rounded-lg px-4 py-3 flex items-center justify-between gap-4 group hover:bg-[#252538] transition-colors">
                    {/* Left: status icon + run ID + timestamp */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0">
                        {isCompleted ? <CheckCircle2 className="w-4 h-4 text-green-500" /> :
                         isFailed    ? <XCircle className="w-4 h-4 text-red-500" /> :
                                       <Loader className="w-4 h-4 text-blue-400 animate-spin" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-mono text-gray-200">#{run.runId.substring(0, 8)}</span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${isCompleted ? 'bg-green-500/15 text-green-300' : isFailed ? 'bg-red-500/15 text-red-300' : 'bg-blue-500/15 text-blue-300'}`}>
                            {isCompleted ? 'Passed' : isFailed ? 'Failed' : 'Running'}
                          </span>
                        </div>
                        <span className="text-[10px] text-gray-500 flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3" />
                          {new Date(run.createdAt || Date.now()).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* Middle: mini live counters */}
                    <div className="hidden md:flex items-center gap-3 text-[11px]">
                      {summary.scenarioCount > 0 && (
                        <span className="flex items-center gap-1 text-gray-400">
                          <Activity className="w-3 h-3" />{summary.scenarioCount} scenario{summary.scenarioCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      {summary.testCaseCount > 0 && (
                        <span className="flex items-center gap-1 text-gray-400">
                          <ListChecks className="w-3 h-3" />{summary.testCaseCount} case{summary.testCaseCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      {summary.passedCount > 0 && (
                        <span className="flex items-center gap-1 text-green-400">
                          <CheckCircle2 className="w-3 h-3" />{summary.passedCount} pass
                        </span>
                      )}
                      {summary.failedCount > 0 && (
                        <span className="flex items-center gap-1 text-red-400">
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
                        className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
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
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-400" />
              <h3 className="text-lg font-bold text-gray-200">Context Documents</h3>
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
          
          <div className="mb-4 text-sm text-gray-400">
            Upload PDF, DOCX, or TXT files. The text will be extracted and passed to the LLM during Test Scenario generation to provide additional context.
          </div>

          {documents.length === 0 ? (
            <div className="text-center py-12 bg-gray-800/30 rounded border border-dashed border-gray-700">
              <FileText className="w-8 h-8 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400">No context documents uploaded for this project yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map((doc, idx) => (
                <div key={idx} className="bg-[#1e1e2d] border border-gray-800 rounded p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-500/10 rounded">
                      <FileText className="w-5 h-5 text-indigo-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-200">{doc.originalName || doc.path.split(/[\\/]/).pop()}</p>
                      <p className="text-xs text-gray-500 mt-1">Uploaded {new Date(doc.uploadedAt).toLocaleString()}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => handleDeleteDocument(doc.path)}
                    className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
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
      <div className={`fixed inset-y-0 right-0 w-full max-w-[560px] bg-gray-900 border-l border-gray-800 shadow-[0_0_40px_rgba(0,0,0,0.5)] transform transition-transform duration-300 ease-in-out z-40 overflow-y-auto ${isPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}>

          {/* SCENARIO PANEL */}
          {isPanelOpen && panelMode === 'scenario' && selectedItem && (
              <div className="h-full flex flex-col">
                  <div className="flex justify-between items-start p-6 border-b border-gray-800 bg-[#161622] sticky top-0 z-10">
                      <div className="pr-4">
                          <p className="text-sm font-medium text-indigo-400 font-mono mb-1">{selectedItem.id}</p>
                          <h2 className="text-xl font-bold text-white leading-tight">Scenario Detail</h2>
                          <div className="flex items-center mt-3 text-sm">
                             {selectedItem.execStatus === 'pass' && <><ShieldCheck className="w-4 h-4 text-green-500 mr-2"/><span className="text-green-400 font-medium">Passed</span></>}
                             {selectedItem.execStatus === 'fail' && <><AlertTriangle className="w-4 h-4 text-red-500 mr-2"/><span className="text-red-400 font-medium">Failed</span></>}
                             {(!selectedItem.execStatus || selectedItem.execStatus === 'pending') && <><Clock className="w-4 h-4 text-yellow-500 mr-2"/><span className="text-yellow-400 font-medium">Pending execution</span></>}
                          </div>
                      </div>
                      <button onClick={closePanel} className="text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 p-2 rounded-full transition-colors flex-shrink-0 mt-1">
                          <X className="w-5 h-5"/>
                      </button>
                  </div>
                  <div className="p-6 space-y-6 flex-1">
                      <div>
                          <h4 className="text-xs uppercase tracking-widest font-bold text-gray-500 mb-2 flex items-center"><span className="w-1 h-4 bg-indigo-500 rounded mr-2"/>Description</h4>
                          <p className="text-gray-300 text-sm leading-relaxed bg-[#1e1e2d] p-4 rounded border border-gray-800">{selectedItem.description}</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                          <div className="bg-[#1e1e2d] p-3 rounded border border-gray-800"><span className="text-xs text-gray-500 block mb-1">Type</span><span className="text-sm font-medium text-white">{selectedItem.type || '—'}</span></div>
                          <div className="bg-[#1e1e2d] p-3 rounded border border-gray-800"><span className="text-xs text-gray-500 block mb-1">Priority</span><span className="text-sm font-medium text-white">{selectedItem.priority || '—'}</span></div>
                      </div>

                      {/* Test Cases Summary inside scenario panel */}
                      {(selectedItem.testCases?.length > 0) && (
                          <div>
                              <h4 className="text-xs uppercase tracking-widest font-bold text-gray-500 mb-2 flex items-center"><span className="w-1 h-4 bg-green-500 rounded mr-2"/>Test Cases ({selectedItem.testCases.length})</h4>
                              <div className="space-y-2">
                                  {selectedItem.testCases.map(tc => (
                                      <div key={tc.testCaseId}
                                          onClick={() => openTestCaseDetails(tc, selectedItem)}
                                          className="cursor-pointer flex items-center justify-between p-3 bg-[#1e1e2d] hover:bg-[#252538] rounded border border-gray-700/50 transition-colors">
                                          <div>
                                              <span className="text-xs font-mono text-indigo-400">{tc.testCaseId}</span>
                                              {tc.version > 1 && <span className="ml-2 text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{tc.version}</span>}
                                              <p className="text-xs text-gray-300 mt-0.5">{tc.title}</p>
                                          </div>
                                          <div className="flex items-center gap-2 flex-shrink-0">
                                              {tc.status === 'pass' && <CheckCircle2 className="w-4 h-4 text-green-400"/>}
                                              {tc.status === 'fail' && <XCircle className="w-4 h-4 text-red-400"/>}
                                              {(!tc.status || tc.status === 'pending') && <Clock className="w-4 h-4 text-yellow-400"/>}
                                              <ChevronRight className="w-4 h-4 text-gray-500"/>
                                          </div>
                                      </div>
                                  ))}
                              </div>
                          </div>
                      )}

                      {selectedItem.lastPRTested && (
                          <div>
                              <h4 className="text-xs uppercase tracking-widest font-bold text-gray-500 mb-2 flex items-center"><span className="w-1 h-4 bg-blue-500 rounded mr-2"/>Last PR Trace</h4>
                              <div className="bg-blue-900/10 border border-blue-900 p-3 rounded"><span className="text-xs text-blue-400 block mb-1">Run ID</span><span className="text-sm text-blue-300 font-mono">{selectedItem.lastPRTested}</span></div>
                          </div>
                      )}
                  </div>
              </div>
          )}

          {/* TEST CASE PANEL */}
          {isPanelOpen && panelMode === 'testcase' && selectedTestCase && (
              <div className="h-full flex flex-col">
                  <div className="flex justify-between items-start p-6 border-b border-gray-800 bg-[#161622] sticky top-0 z-10">
                      <div className="pr-4 min-w-0">
                          <p className="text-[10px] text-gray-500 mb-1">
                              {selectedTestCase.parentScenario?.id} → <span className="text-indigo-400 font-mono">{selectedTestCase.testCaseId}</span>
                              {selectedTestCase.version > 1 && <span className="ml-2 text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{selectedTestCase.version}</span>}
                          </p>
                          <h2 className="text-lg font-bold text-white leading-tight">{selectedTestCase.title}</h2>
                          <div className="flex items-center mt-2 text-xs gap-3">
                              {selectedTestCase.status === 'pass' && <span className="flex items-center gap-1 text-green-400"><CheckCircle2 className="w-3.5 h-3.5"/>Passed</span>}
                              {selectedTestCase.status === 'fail' && <span className="flex items-center gap-1 text-red-400"><XCircle className="w-3.5 h-3.5"/>Failed</span>}
                              {(!selectedTestCase.status || selectedTestCase.status === 'pending') && <span className="flex items-center gap-1 text-yellow-400"><Clock className="w-3.5 h-3.5"/>Pending</span>}
                              {selectedTestCase.language && <span className="flex items-center gap-1 text-gray-400"><Code2 className="w-3.5 h-3.5"/>{selectedTestCase.language}</span>}
                          </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                          <button onClick={() => { setPanelMode('scenario'); setSelectedItem(selectedTestCase.parentScenario); }} className="text-gray-400 hover:text-indigo-400 bg-gray-800 hover:bg-gray-700 p-2 rounded-full transition-colors" title="Back to scenario">
                              <ChevronRight className="w-4 h-4 rotate-180"/>
                          </button>
                          <button onClick={closePanel} className="text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 p-2 rounded-full transition-colors">
                              <X className="w-5 h-5"/>
                          </button>
                      </div>
                  </div>

                  {/* Tab bar */}
                  <div className="flex border-b border-gray-800 bg-[#1a1a26]">
                      {[['steps','Steps','ListChecks'], ['script','Test Script','Code2'], ['data','Test Data','Database']].map(([key, label, _]) => (
                          <button key={key} onClick={() => setTcPanelTab(key)}
                              className={`px-5 py-3 text-xs font-medium border-b-2 transition-colors ${tcPanelTab === key ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
                              {label}
                          </button>
                      ))}
                  </div>

                  <div className="p-6 flex-1 overflow-auto">
                      {/* Steps Tab */}
                      {tcPanelTab === 'steps' && (
                          <div className="space-y-3">
                              {(selectedTestCase.steps || []).length === 0
                                  ? <p className="text-sm text-gray-500 italic">No steps recorded.</p>
                                  : (selectedTestCase.steps || []).map((step, i) => (
                                      <div key={i} className="bg-[#1e1e2d] border border-gray-800 rounded p-3">
                                          <div className="flex items-start gap-3">
                                              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[10px] flex items-center justify-center font-bold">{i + 1}</span>
                                              <div className="min-w-0">
                                                  <p className="text-xs text-gray-200 font-medium mb-1">{step.action}</p>
                                                  {step.expectedResult && (
                                                      <p className="text-[10px] text-gray-500 italic">Expected: {step.expectedResult}</p>
                                                  )}
                                              </div>
                                          </div>
                                      </div>
                                  ))
                              }
                              {selectedTestCase.codeFiles?.length > 0 && (
                                  <div className="mt-4">
                                      <h5 className="text-xs text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1"><GitBranch className="w-3 h-3"/>Covers Files</h5>
                                      <div className="space-y-1">
                                          {selectedTestCase.codeFiles.map(f => (
                                              <span key={f} className="block text-[11px] font-mono text-gray-400 bg-gray-800/50 px-2 py-1 rounded">{f}</span>
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
                                  ? <pre className="text-xs text-gray-300 bg-[#0d0d14] p-4 rounded border border-gray-800 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">{selectedTestCase.testScript}</pre>
                                  : <p className="text-sm text-gray-500 italic">No test script generated yet.</p>
                              }
                          </div>
                      )}

                      {/* Data Tab */}
                      {tcPanelTab === 'data' && (
                          <div>
                              {selectedTestCase.testData && Object.keys(selectedTestCase.testData).length > 0
                                  ? <pre className="text-xs text-gray-300 bg-[#0d0d14] p-4 rounded border border-gray-800 overflow-auto whitespace-pre-wrap font-mono">{JSON.stringify(selectedTestCase.testData, null, 2)}</pre>
                                  : <p className="text-sm text-gray-500 italic">No test data recorded.</p>
                              }
                          </div>
                      )}
                  </div>

                  {/* Footer meta */}
                  <div className="px-6 py-3 border-t border-gray-800 bg-[#161622] text-[10px] text-gray-600 flex items-center justify-between">
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
