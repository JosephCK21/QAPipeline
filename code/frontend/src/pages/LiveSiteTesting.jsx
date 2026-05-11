import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../App';
import { io } from 'socket.io-client';
import {
  Globe, Upload, Play, CheckCircle2, XCircle, Loader,
  AlertTriangle, FileText, Clock, ChevronDown, ChevronUp
} from 'lucide-react';

const API_BASE = 'http://localhost:3001';

function LiveSiteTesting() {
  const { refreshKey, showToast, darkMode } = useAppContext();

  const [url, setUrl] = useState('');
  const [frdText, setFrdText] = useState('');
  const [frdFile, setFrdFile] = useState(null);
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [runs, setRuns] = useState([]);
  const [expandedRun, setExpandedRun] = useState(null);
  const [runDetails, setRunDetails] = useState({});

  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;

  useEffect(() => {
    const socket = io(API_BASE);

    socket.on('run_updated', (data) => {
      const currentActiveId = activeRunIdRef.current;
      if (data.runId === currentActiveId && data.type === 'complete') {
        setActiveRunId(null);
      }
      if (data.runId === currentActiveId || (expandedRun && data.runId === expandedRun)) {
        fetchRunDetails(data.runId);
      }
    });

    return () => socket.disconnect();
  }, [expandedRun]);

  useEffect(() => {
    fetch(`${API_BASE}/api/projects`)
      .then(r => r.json())
      .then(data => {
        const list = Array.isArray(data) ? data : [];
        setProjects(list);
        if (list.length > 0 && !projectId) setProjectId(list[0].id);
      })
      .catch(() => {});
  }, [refreshKey]);

  useEffect(() => {
    if (!projectId) return;
    fetch(`${API_BASE}/api/projects/${projectId}/live-site-runs`)
      .then(r => r.json())
      .then(data => setRuns(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [projectId, refreshKey]);

  const handleStart = async () => {
    if (!url.trim()) { showToast('Please enter a website URL', 'error'); return; }
    if (!projectId) { showToast('Please select a project', 'error'); return; }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('url', url.trim());
      if (frdText.trim()) formData.append('frdText', frdText.trim());
      if (frdFile) formData.append('frdFile', frdFile);

      const res = await fetch(`${API_BASE}/api/projects/${projectId}/live-site-runs`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start run');

      setActiveRunId(data.runId);
      showToast(`Live site testing started (run ${data.runId.slice(0, 6)})`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchRunDetails = async (runId) => {
    try {
      const [runRes, tcRes] = await Promise.all([
        fetch(`${API_BASE}/api/runs/${runId}`),
        fetch(`${API_BASE}/api/runs/${runId}/test-cases`)
      ]);
      const run = await runRes.json();
      const testCases = await tcRes.json();
      setRunDetails(prev => ({ ...prev, [runId]: { run, testCases: Array.isArray(testCases) ? testCases : [] } }));
    } catch { /* ignore */ }
  };

  const toggleExpand = (runId) => {
    if (expandedRun === runId) {
      setExpandedRun(null);
    } else {
      setExpandedRun(runId);
      if (!runDetails[runId]) fetchRunDetails(runId);
    }
  };

  const getStatusIcon = (status) => {
    if (status === 'completed') return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    if (status === 'failed') return <XCircle className="w-4 h-4 text-red-500" />;
    if (status === 'running') return <Loader className="w-4 h-4 text-blue-500 animate-spin" />;
    return <Clock className="w-4 h-4 text-gray-400" />;
  };

  const getTcStatusChip = (status) => {
    const base = 'px-2 py-0.5 text-xs rounded-full font-medium';
    if (status === 'pass') return <span className={`${base} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400`}>Pass</span>;
    if (status === 'fail') return <span className={`${base} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400`}>Fail</span>;
    if (status === 'running' || status === 'healing') return <span className={`${base} bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400`}>{status}</span>;
    return <span className={`${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400`}>{status || 'pending'}</span>;
  };

  const cardBg = darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-white border-[#DFE1E6]';
  const inputBg = darkMode ? 'bg-[#0D1117] border-[#30363D] text-[#E6EDF3] placeholder-[#484F58]' : 'bg-white border-[#DFE1E6] text-[#172B4D] placeholder-[#97A0AF]';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-md">
          <Globe className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>Live Site Testing</h1>
          <p className={`text-sm ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>Test a running website on the fly with AI-generated scenarios</p>
        </div>
      </div>

      {/* Input Form */}
      <div className={`border rounded-xl p-6 space-y-4 ${cardBg}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-[#C9D1D9]' : 'text-[#44546F]'}`}>Website URL</label>
            <input
              type="url"
              placeholder="https://example.com"
              value={url}
              onChange={e => setUrl(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${inputBg}`}
            />
          </div>

          <div>
            <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-[#C9D1D9]' : 'text-[#44546F]'}`}>Project</label>
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${inputBg}`}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-[#C9D1D9]' : 'text-[#44546F]'}`}>FRD Document (optional)</label>
            <div className="relative">
              <input
                type="file"
                accept=".pdf,.docx,.doc,.txt"
                onChange={e => setFrdFile(e.target.files?.[0] || null)}
                className={`w-full px-3 py-2 rounded-lg border text-sm file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 ${inputBg}`}
              />
            </div>
          </div>

          <div className="md:col-span-2">
            <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-[#C9D1D9]' : 'text-[#44546F]'}`}>FRD Text (paste requirements here, optional)</label>
            <textarea
              rows={4}
              placeholder="Paste your functional requirements here, or upload a document above..."
              value={frdText}
              onChange={e => setFrdText(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y ${inputBg}`}
            />
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={handleStart}
            disabled={loading || !url.trim()}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? 'Starting...' : 'Start Testing'}
          </button>
        </div>
      </div>

      {/* Active Run Indicator */}
      {activeRunId && (
        <div className={`border rounded-xl p-4 flex items-center gap-3 ${darkMode ? 'bg-[rgba(56,139,253,0.1)] border-[rgba(56,139,253,0.3)]' : 'bg-blue-50 border-blue-200'}`}>
          <Loader className="w-5 h-5 text-blue-500 animate-spin" />
          <div>
            <p className={`text-sm font-medium ${darkMode ? 'text-[#58A6FF]' : 'text-blue-700'}`}>
              Live site testing in progress
            </p>
            <p className={`text-xs ${darkMode ? 'text-[#8B949E]' : 'text-blue-600/70'}`}>
              Run {activeRunId.slice(0, 8)} — check Pipeline Runs for live progress
            </p>
          </div>
        </div>
      )}

      {/* Previous Runs */}
      <div>
        <h2 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>Previous Live Site Runs</h2>
        {runs.length === 0 ? (
          <div className={`border rounded-xl p-8 text-center ${cardBg}`}>
            <Globe className={`w-10 h-10 mx-auto mb-3 ${darkMode ? 'text-[#484F58]' : 'text-[#97A0AF]'}`} />
            <p className={`text-sm ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>No live site runs yet. Enter a URL above to get started.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {runs.map(run => {
              const details = runDetails[run.runId];
              const isExpanded = expandedRun === run.runId;

              return (
                <div key={run.runId} className={`border rounded-xl overflow-hidden ${cardBg}`}>
                  <button
                    onClick={() => toggleExpand(run.runId)}
                    className={`w-full flex items-center justify-between px-5 py-3.5 text-left hover:${darkMode ? 'bg-[#1C2333]' : 'bg-[#F4F5F7]'} transition`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {getStatusIcon(run.status)}
                      <div className="min-w-0">
                        <p className={`text-sm font-medium truncate ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>
                          {run.targetUrl || run.repoFullName || run.runId.slice(0, 8)}
                        </p>
                        <p className={`text-xs ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                          {run.runId.slice(0, 8)} &middot; {run.createdAt ? new Date(run.createdAt).toLocaleString() : 'Unknown time'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {run.finished_passed_count != null && (
                        <span className="text-xs text-green-600 font-medium">{run.finished_passed_count} passed</span>
                      )}
                      {run.finished_failed_count != null && run.finished_failed_count > 0 && (
                        <span className="text-xs text-red-600 font-medium">{run.finished_failed_count} failed</span>
                      )}
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className={`px-5 pb-4 border-t ${darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]'}`}>
                      {!details ? (
                        <div className="py-4 text-center">
                          <Loader className="w-5 h-5 mx-auto animate-spin text-blue-500" />
                        </div>
                      ) : details.testCases.length === 0 ? (
                        <p className={`py-4 text-sm text-center ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>No test cases found for this run.</p>
                      ) : (
                        <table className="w-full mt-3">
                          <thead>
                            <tr className={`text-xs uppercase ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                              <th className="text-left py-2 font-medium">Test Case</th>
                              <th className="text-left py-2 font-medium">Scenario</th>
                              <th className="text-center py-2 font-medium">Status</th>
                              <th className="text-center py-2 font-medium">Heals</th>
                            </tr>
                          </thead>
                          <tbody>
                            {details.testCases.map(tc => (
                              <tr key={tc.testCaseId} className={`border-t ${darkMode ? 'border-[#21262D]' : 'border-[#EBECF0]'}`}>
                                <td className={`py-2 text-sm ${darkMode ? 'text-[#C9D1D9]' : 'text-[#172B4D]'}`}>
                                  <span className="font-mono text-xs">{tc.testCaseId}</span>
                                  {tc.title && <span className="ml-2 text-xs opacity-70">{tc.title}</span>}
                                </td>
                                <td className={`py-2 text-xs ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>{tc.scenarioId}</td>
                                <td className="py-2 text-center">{getTcStatusChip(tc.status)}</td>
                                <td className={`py-2 text-center text-xs ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>{tc.healAttempts || 0}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default LiveSiteTesting;
