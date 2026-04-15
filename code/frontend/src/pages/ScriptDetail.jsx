import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAppContext } from '../App';
import {
  ArrowLeft, AlertTriangle, Loader, CheckCircle2, XCircle, Clock,
  ChevronRight, ChevronDown, Code2, Database, ListChecks, RefreshCw,
  Activity, GitBranch, Terminal
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function statusColor(status) {
  if (status === 'pass')       return 'text-green-400';
  if (status === 'fail' || status === 'final_fail') return 'text-red-400';
  if (status === 'running')    return 'text-blue-400';
  if (status === 'generating') return 'text-indigo-400';
  if (status === 'partial')    return 'text-orange-400';
  return 'text-gray-400';
}

function statusIcon(status, size = 'w-4 h-4') {
  if (status === 'pass')                         return <CheckCircle2 className={`${size} text-green-400`} />;
  if (status === 'fail' || status === 'final_fail') return <XCircle className={`${size} text-red-400`} />;
  if (status === 'running' || status === 'generating') return <Loader className={`${size} text-blue-400 animate-spin`} />;
  if (status === 'partial')                      return <AlertTriangle className={`${size} text-orange-400`} />;
  return <Clock className={`${size} text-gray-500`} />;
}

function statusBadge(status) {
  const map = {
    pass:       'bg-green-500/15 border-green-500/30 text-green-300',
    fail:       'bg-red-500/15 border-red-500/30 text-red-300',
    final_fail: 'bg-red-500/15 border-red-500/30 text-red-300',
    running:    'bg-blue-500/15 border-blue-500/30 text-blue-300',
    generating: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300',
    partial:    'bg-orange-500/15 border-orange-500/30 text-orange-300',
  };
  return map[status] || 'bg-gray-700/30 border-gray-600/30 text-gray-400';
}

// ---------------------------------------------------------------------------
// Attempt Timeline Row
// ---------------------------------------------------------------------------
function AttemptRow({ attempt }) {
  const [open, setOpen] = useState(false);
  const label = attempt.status === 'final_fail' ? `Attempt ${attempt.attempt} — Final Fail`
    : `Attempt ${attempt.attempt} — ${attempt.status === 'pass' ? 'Passed' : 'Failed'}`;

  return (
    <div className="border border-gray-800 rounded">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded ${open ? 'bg-[#1a1a26]' : 'hover:bg-gray-800/40'} transition-colors`}
      >
        <div className="flex items-center gap-2">
          {statusIcon(attempt.status, 'w-3.5 h-3.5')}
          <span className={statusColor(attempt.status)}>{label}</span>
          {attempt.startedAt && (
            <span className="text-gray-600 text-[10px]">{new Date(attempt.startedAt).toLocaleTimeString()}</span>
          )}
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-gray-800 bg-[#0d0d14] rounded-b">
          {attempt.failureOutput && (
            <div className="mt-2">
              <p className="text-[10px] text-red-400 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Terminal className="w-3 h-3" /> Failure Output
              </p>
              <pre className="text-[10px] text-red-300 font-mono whitespace-pre-wrap overflow-auto max-h-48 bg-red-900/10 border border-red-900/30 p-2 rounded">
                {attempt.failureOutput}
              </pre>
            </div>
          )}
          {attempt.scriptSnapshot && (
            <div className="mt-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Code2 className="w-3 h-3" /> Script Used in This Attempt
              </p>
              <pre className="text-[10px] text-gray-300 font-mono whitespace-pre-wrap overflow-auto max-h-64 bg-[#0a0a12] border border-gray-800 p-2 rounded">
                {attempt.scriptSnapshot}
              </pre>
            </div>
          )}
          {attempt.output && attempt.status === 'pass' && (
            <div className="mt-2">
              <p className="text-[10px] text-green-400 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Terminal className="w-3 h-3" /> Sandbox Output
              </p>
              <pre className="text-[10px] text-green-300 font-mono whitespace-pre-wrap overflow-auto max-h-48 bg-green-900/10 border border-green-900/30 p-2 rounded">
                {attempt.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test Case Detail Panel (right side)
// ---------------------------------------------------------------------------
function TestCasePanel({ testCase, attempts }) {
  const [tab, setTab] = useState('steps');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-800 bg-[#161622]">
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${statusBadge(testCase.status)}`}>
            {testCase.status || 'pending'}
          </span>
          {testCase.version > 1 && (
            <span className="text-[9px] px-1.5 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{testCase.version}</span>
          )}
          {testCase.healAttempts > 0 && (
            <span className="text-[9px] flex items-center gap-0.5 text-orange-400">
              <RefreshCw className="w-3 h-3" />{testCase.healAttempts} heal{testCase.healAttempts !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <p className="text-xs font-mono text-indigo-400">{testCase.testCaseId}</p>
        <p className="text-sm font-semibold text-white mt-0.5 leading-tight">{testCase.title}</p>
        {testCase.language && (
          <p className="text-[10px] text-gray-500 mt-1 flex items-center gap-1">
            <Code2 className="w-3 h-3" />{testCase.language}
          </p>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 bg-[#1a1a26]">
        {[['steps', 'Steps'], ['script', 'Script'], ['data', 'Test Data'], ['attempts', `Attempts (${attempts.length})`]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === key ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-4 bg-[#0d0d14]">
        {tab === 'steps' && (
          <div className="space-y-2">
            {(!testCase.steps || testCase.steps.length === 0)
              ? <p className="text-sm text-gray-500 italic">No steps recorded.</p>
              : testCase.steps.map((step, i) => (
                  <div key={i} className="flex gap-3 bg-[#1e1e2d] border border-gray-800 p-3 rounded">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[10px] flex items-center justify-center font-bold">{i + 1}</span>
                    <div>
                      <p className="text-xs text-gray-200 font-medium">{step.action}</p>
                      {step.expectedResult && <p className="text-[10px] text-gray-500 italic mt-0.5">Expected: {step.expectedResult}</p>}
                    </div>
                  </div>
                ))
            }
            {testCase.codeFiles?.length > 0 && (
              <div className="mt-4">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1"><GitBranch className="w-3 h-3"/>Covers</p>
                {testCase.codeFiles.map(f => (
                  <span key={f} className="block text-[11px] font-mono text-gray-400 bg-gray-800/50 px-2 py-0.5 rounded mb-1">{f}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'script' && (
          testCase.testScript
            ? <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">{testCase.testScript}</pre>
            : <p className="text-sm text-gray-500 italic">No script generated.</p>
        )}

        {tab === 'data' && (
          testCase.testData && Object.keys(testCase.testData).length > 0
            ? <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap">{JSON.stringify(testCase.testData, null, 2)}</pre>
            : <p className="text-sm text-gray-500 italic">No test data.</p>
        )}

        {tab === 'attempts' && (
          <div className="space-y-2">
            {attempts.length === 0
              ? <p className="text-sm text-gray-500 italic">No attempt records yet.</p>
              : attempts.map((att, i) => <AttemptRow key={i} attempt={att} />)
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ScriptDetail Page
// ---------------------------------------------------------------------------
function ScriptDetail() {
  const { projectId, runId } = useParams();
  const { refreshKey } = useAppContext();

  const [runData, setRunData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // UI state
  const [expandedScenarios, setExpandedScenarios] = useState({});
  const [selectedTestCase, setSelectedTestCase] = useState(null);

  useEffect(() => {
    const fetchRunData = async () => {
      try {
        const [runsRes, tcRes] = await Promise.all([
          fetch('http://localhost:3001/api/runs'),
          fetch(`http://localhost:3001/api/runs/${runId}/test-cases`).catch(() => ({ ok: false }))
        ]);

        if (!runsRes.ok) { setError('Failed to load runs.'); return; }

        const runs = await runsRes.json();
        const targetRun = runs.find(r => r.runId === runId);
        if (!targetRun) { setError('Run not found.'); return; }

        // Attach test cases fetched separately (if endpoint exists)
        if (tcRes.ok) {
          const tcData = await tcRes.json();
          targetRun._testCases = tcData;
        }

        setRunData(targetRun);
      } catch (e) {
        setError('Error connecting to server.');
      } finally {
        setLoading(false);
      }
    };
    fetchRunData();
  }, [runId, refreshKey]);

  if (loading) return (
    <div className="flex items-center justify-center h-full text-gray-400">
      <Loader className="w-8 h-8 animate-spin" />
    </div>
  );

  if (error || !runData) return (
    <div className="p-8 text-center text-red-400">
      <AlertTriangle className="w-10 h-10 mx-auto mb-4" />
      <p>{error || 'No data available.'}</p>
      <Link to={`/projects/${projectId}`} className="text-indigo-400 hover:underline mt-4 inline-block">Return to Project</Link>
    </div>
  );

  // Build hierarchical view from events
  const events = runData.events || [];

  // Summary from last run_summary_updated event
  const summaryEvent = [...events].reverse().find(e => e.type === 'run_summary_updated');
  const summary = summaryEvent?.data || {};

  // Scenario statuses: latest per scenarioId
  const scenarioStatuses = {};
  for (const ev of events) {
    if (ev.type === 'scenario_execution_updated') {
      scenarioStatuses[ev.data.scenarioId] = ev.data;
    }
  }

  // Test case attempts: group by testCaseId
  const testCaseAttempts = {};
  for (const ev of events) {
    if (ev.type === 'test_case_attempt') {
      const id = ev.data.testCaseId;
      if (!testCaseAttempts[id]) testCaseAttempts[id] = [];
      testCaseAttempts[id].push(ev.data);
    }
  }

  // PR mapping to know which scenarios were covered
  const mappingEvent = events.find(e => e.type === 'pr_scenario_mapping');
  const mappedScenarioIds = (mappingEvent?.data?.mappings || []).map(m => m.id || m.scenarioId).filter(Boolean);

  // Test cases either from dedicated endpoint or embedded in run events
  const savedTcEvents = events.filter(e => e.type === 'test_cases_saved');
  const savedTcScenarioIds = [...new Set(savedTcEvents.map(e => e.data?.scenarioId).filter(Boolean))];

  // All scenario IDs we have data for
  const allScenarioIds = [...new Set([...mappedScenarioIds, ...Object.keys(scenarioStatuses), ...savedTcScenarioIds])];

  // Test cases from _testCases endpoint (grouped by scenarioId)
  const tcByScenario = {};
  if (runData._testCases) {
    for (const tc of runData._testCases) {
      if (!tcByScenario[tc.scenarioId]) tcByScenario[tc.scenarioId] = [];
      tcByScenario[tc.scenarioId].push(tc);
    }
  }

  const prDetails = events.find(e => e.type === 'pr_details')?.data || {};
  const isRunning = runData.status === 'running';
  const isFailed = runData.status === 'failed' || runData.status === 'error';
  const isCompleted = runData.status === 'completed';

  const toggleScenario = (id) => setExpandedScenarios(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="flex flex-col h-full space-y-4 max-w-full">
      {/* Back nav */}
      <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-200 transition-colors text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Project
      </Link>

      {/* Run Header */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-mono text-gray-400">Run #{runId.substring(0, 8)}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${statusBadge(isCompleted ? 'pass' : isFailed ? 'fail' : 'running')}`}>
              {isCompleted ? 'Completed' : isFailed ? 'Failed' : 'Running'}
            </span>
            {isRunning && <Loader className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
          </div>
          {prDetails.title && <p className="text-base font-bold text-white">{prDetails.title}</p>}
          {prDetails.branch && <p className="text-xs text-gray-500 mt-1 flex items-center gap-1"><GitBranch className="w-3 h-3"/>{prDetails.branch}</p>}
        </div>

        {/* Mini counters */}
        <div className="flex items-center gap-4 text-xs">
          {summary.scenarioCount > 0 && <span className="flex items-center gap-1 text-gray-400"><Activity className="w-3.5 h-3.5"/>{summary.scenarioCount} scenarios</span>}
          {summary.testCaseCount > 0 && <span className="flex items-center gap-1 text-gray-400"><ListChecks className="w-3.5 h-3.5"/>{summary.testCaseCount} cases</span>}
          {summary.passedCount > 0 && <span className="flex items-center gap-1 text-green-400"><CheckCircle2 className="w-3.5 h-3.5"/>{summary.passedCount} passed</span>}
          {summary.failedCount > 0 && <span className="flex items-center gap-1 text-red-400"><XCircle className="w-3.5 h-3.5"/>{summary.failedCount} failed</span>}
          {summary.retryCount > 0 && <span className="flex items-center gap-1 text-orange-400"><RefreshCw className="w-3.5 h-3.5"/>{summary.retryCount} retries</span>}
        </div>
      </div>

      {/* Main content: scenario list + test case panel side-by-side */}
      <div className="flex flex-1 gap-4 min-h-0 overflow-hidden" style={{ minHeight: '520px' }}>
        {/* Left: Scenario list */}
        <div className="w-full md:w-[340px] flex-shrink-0 bg-gray-900 border border-gray-800 rounded-lg overflow-y-auto">
          <div className="p-3 border-b border-gray-800">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Scenarios & Test Cases</p>
          </div>

          {allScenarioIds.length === 0 ? (
            <div className="p-6 text-center text-gray-500 text-sm italic">
              {isRunning ? 'Generating test cases…' : 'No scenarios mapped to this PR.'}
            </div>
          ) : (
            <div className="divide-y divide-gray-800">
              {allScenarioIds.map(scenarioId => {
                const sStatus = scenarioStatuses[scenarioId];
                const isExpanded = !!expandedScenarios[scenarioId];
                const tcs = tcByScenario[scenarioId] || [];

                return (
                  <div key={scenarioId}>
                    {/* Scenario Row */}
                    <button
                      onClick={() => toggleScenario(scenarioId)}
                      className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-800/50 transition-colors text-left"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {statusIcon(sStatus?.status || (isRunning ? 'running' : 'pending'), 'w-3.5 h-3.5')}
                        <span className="text-xs font-mono text-indigo-300 truncate">{scenarioId}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {tcs.length > 0 && (
                          <span className="text-[10px] text-gray-500">{tcs.filter(t => t.status === 'pass').length}/{tcs.length}</span>
                        )}
                        {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}
                      </div>
                    </button>

                    {/* Test Cases under scenario */}
                    {isExpanded && (
                      <div className="bg-[#0d0d14]">
                        {tcs.length === 0 ? (
                          <p className="px-4 py-2 text-[10px] text-gray-600 italic">
                            {isRunning ? 'Generating…' : 'No test cases.'}
                          </p>
                        ) : (
                          tcs.map(tc => {
                            const isSelected = selectedTestCase?.testCaseId === tc.testCaseId;
                            return (
                              <button
                                key={tc.testCaseId}
                                onClick={() => setSelectedTestCase(tc)}
                                className={`w-full flex items-center justify-between px-4 py-2 text-left transition-colors border-l-2 ${
                                  isSelected
                                    ? 'bg-indigo-500/10 border-indigo-500'
                                    : 'hover:bg-gray-800/40 border-transparent'
                                }`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {statusIcon(tc.status, 'w-3 h-3')}
                                  <div className="min-w-0">
                                    <p className="text-[10px] font-mono text-gray-400 truncate">{tc.testCaseId}</p>
                                    <p className="text-[10px] text-gray-500 truncate">{tc.title}</p>
                                  </div>
                                </div>
                                <div className="flex-shrink-0 flex items-center gap-1">
                                  {tc.version > 1 && <span className="text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{tc.version}</span>}
                                  {tc.healAttempts > 0 && <RefreshCw className="w-3 h-3 text-orange-400" />}
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Test Case Detail */}
        <div className="flex-1 bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {selectedTestCase ? (
            <TestCasePanel
              testCase={selectedTestCase}
              attempts={testCaseAttempts[selectedTestCase.testCaseId] || []}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <ListChecks className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">Select a test case to see details</p>
              <p className="text-xs mt-1 opacity-70">Expand a scenario on the left to see its test cases</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ScriptDetail;
