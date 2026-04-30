import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAppContext } from '../App';
import {
  ArrowLeft, AlertTriangle, Loader, CheckCircle2, XCircle, Clock,
  ChevronRight, ChevronDown, Code2, Database, ListChecks, RefreshCw,
  Activity, GitBranch, Terminal, ShieldAlert, Wrench, ImageIcon, Film
} from 'lucide-react';

const API_BASE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
  ? String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, '')
  : 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function statusColor(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'pass') return 'text-[#00875A]';
  if (s === 'fail' || s === 'final_fail') return 'text-[#C9372C]';
  if (s === 'healing') return 'text-[#0C66E4]';
  if (s === 'running') return 'text-[#B65C00]';
  if (s === 'generating') return 'text-indigo-400';
  if (s === 'partial') return 'text-orange-400';
  return 'text-[#5E6C84]';
}

function statusIcon(status, size = 'w-4 h-4') {
  const s = String(status || '').toLowerCase();
  if (s === 'pass') return <CheckCircle2 className={`${size} text-[#00875A]`} />;
  if (s === 'fail' || s === 'final_fail') return <XCircle className={`${size} text-[#C9372C]`} />;
  if (s === 'healing') return <RefreshCw className={`${size} text-[#0C66E4] animate-pulse`} />;
  if (s === 'running') return <Loader className={`${size} text-[#B65C00] animate-spin`} />;
  if (s === 'generating') return <Loader className={`${size} text-indigo-400 animate-spin`} />;
  if (s === 'partial') return <AlertTriangle className={`${size} text-orange-400`} />;
  return <Clock className={`${size} text-[#8993A4]`} />;
}

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  const map = {
    pass:       'bg-green-500/15 border-green-500/30 text-[#00875A]',
    fail:       'bg-red-500/15 border-red-500/30 text-[#C9372C]',
    final_fail: 'bg-red-500/15 border-red-500/30 text-[#C9372C]',
    running:    'bg-amber-500/15 border-amber-500/30 text-[#B65C00]',
    healing:    'bg-blue-500/15 border-blue-500/30 text-[#0C66E4]',
    generating: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300',
    partial:    'bg-orange-500/15 border-orange-500/30 text-orange-300',
  };
  return map[s] || 'bg-[#DFE1E6]/30 border-[#C1C7D0]/30 text-[#5E6C84]';
}

// ---------------------------------------------------------------------------
// Regression pill — shown on attempts and test-case headers when a regression
// run stamped the outcome.
// ---------------------------------------------------------------------------
function RegressionPill({ regression }) {
  if (!regression || regression === 'clean_pass') return null;

  const styleMap = {
    adapted:         { cls: 'bg-[#FFF7D6] border-[#F8E08E] text-[#B65C00]', icon: <Wrench className="w-3 h-3" />,       label: 'Adapted' },
    regression_fail: { cls: 'bg-[#FFEBE6] border-[#FFBDAD] text-[#C9372C]', icon: <ShieldAlert className="w-3 h-3" />, label: 'Regression' },
    pending:         { cls: 'bg-[#DEEBFF] border-[#B3D4FF] text-[#0747A6]', icon: <RefreshCw className="w-3 h-3" />,    label: 'Regression run' }
  };
  const entry = styleMap[regression];
  if (!entry) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-semibold ${entry.cls}`}>
      {entry.icon}{entry.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Attempt Timeline Row
// ---------------------------------------------------------------------------
function AttemptRow({ attempt }) {
  const [open, setOpen] = useState(false);
  const label = attempt.status === 'final_fail' ? `Attempt ${attempt.attempt} — Final Fail`
    : `Attempt ${attempt.attempt} — ${attempt.status === 'pass' ? 'Passed' : 'Failed'}`;

  return (
    <div className="border border-[#DFE1E6] rounded">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded ${open ? 'bg-[#F4F5F7]' : 'hover:bg-[#F1F2F4]'} transition-colors`}
      >
        <div className="flex items-center gap-2">
          {statusIcon(attempt.status, 'w-3.5 h-3.5')}
          <span className={statusColor(attempt.status)}>{label}</span>
          <RegressionPill regression={attempt.regression} />
          {attempt.startedAt && (
            <span className="text-[#8993A4] text-[10px]">{new Date(attempt.startedAt).toLocaleTimeString()}</span>
          )}
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-[#8993A4]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#8993A4]" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-[#DFE1E6] bg-[#FAFBFC] rounded-b">
          {attempt.failureScreenshots?.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] text-[#5E6C84] uppercase tracking-wider mb-1 flex items-center gap-1">
                <ImageIcon className="w-3 h-3" /> Playwright failure screenshots
              </p>
              <div className="space-y-2">
                {attempt.failureScreenshots.map((s) => (
                  <a
                    key={s.url}
                    href={`${API_BASE}${s.url}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block border border-[#DFE1E6] rounded overflow-hidden bg-[#FFFFFF] hover:ring-2 hover:ring-indigo-400/40"
                  >
                    <img
                      src={`${API_BASE}${s.url}`}
                      alt={s.fileName || 'Failure screenshot'}
                      className="w-full max-h-64 object-contain bg-[#171717]"
                    />
                    <span className="block text-[9px] text-[#8993A4] px-2 py-1 truncate">{s.fileName}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {attempt.traces?.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] text-[#5E6C84] uppercase tracking-wider mb-1 flex items-center gap-1">
                <Film className="w-3 h-3" /> Trace files
              </p>
              <ul className="text-[11px] text-indigo-500 space-y-1">
                {attempt.traces.map((t) => (
                  <li key={t.url}>
                    <a href={`${API_BASE}${t.url}`} download={t.fileName} className="hover:underline break-all">{t.fileName}</a>
                    <span className="block text-[9px] text-[#8993A4] mt-0.5">
                      Inspect locally with: <code className="bg-[#F4F5F7] px-1 rounded text-[10px]">npx playwright show-trace &lt;this-file.zip&gt;</code>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {attempt.failureOutput && (
            <div className="mt-2">
              <p className="text-[10px] text-[#C9372C] uppercase tracking-wider mb-1 flex items-center gap-1">
                <Terminal className="w-3 h-3" /> Failure Output
              </p>
              <pre className="text-[10px] text-[#C9372C] font-mono whitespace-pre-wrap overflow-auto max-h-48 bg-red-900/10 border border-red-900/30 p-2 rounded">
                {attempt.failureOutput}
              </pre>
            </div>
          )}
          {attempt.scriptSnapshot && (
            <div className="mt-2">
              <p className="text-[10px] text-[#8993A4] uppercase tracking-wider mb-1 flex items-center gap-1">
                <Code2 className="w-3 h-3" /> Script Used in This Attempt
              </p>
              <pre className="text-[10px] text-[#5E6C84] font-mono whitespace-pre-wrap overflow-auto max-h-64 bg-[#F4F5F7] border border-[#DFE1E6] p-2 rounded">
                {attempt.scriptSnapshot}
              </pre>
            </div>
          )}
          {attempt.output && attempt.status === 'pass' && (
            <div className="mt-2">
              <p className="text-[10px] text-[#00875A] uppercase tracking-wider mb-1 flex items-center gap-1">
                <Terminal className="w-3 h-3" /> Sandbox Output
              </p>
              <pre className="text-[10px] text-[#00875A] font-mono whitespace-pre-wrap overflow-auto max-h-48 bg-green-900/10 border border-green-900/30 p-2 rounded">
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
      <div className="p-4 border-b border-[#DFE1E6] bg-[#F4F5F7]">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
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
          <RegressionPill regression={testCase.regression} />
        </div>
        <p className="text-xs font-mono text-indigo-400">{testCase.testCaseId}</p>
        <p className="text-sm font-semibold text-[#172B4D] mt-0.5 leading-tight">{testCase.title}</p>
        {testCase.language && (
          <p className="text-[10px] text-[#8993A4] mt-1 flex items-center gap-1">
            <Code2 className="w-3 h-3" />{testCase.language}
          </p>
        )}
      </div>

      {/* Regression banner — shown when the test case was adapted or failed in a regression run */}
      {(testCase.regression === 'adapted' || testCase.regression === 'regression_fail') && testCase.originalFailureOutput && (
        <div className={`px-4 py-3 border-b ${testCase.regression === 'adapted' ? 'bg-[#FFF7D6] border-[#F8E08E]' : 'bg-[#FFEBE6] border-[#FFBDAD]'}`}>
          <p className="text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1 mb-1" style={{ color: testCase.regression === 'adapted' ? '#B65C00' : '#C9372C' }}>
            <ShieldAlert className="w-3 h-3" />
            {testCase.regression === 'adapted'
              ? 'Potential regression — original script failed, adapted version passed'
              : 'Regression failure — existing script could not be made green'}
          </p>
          <details className="text-[11px]">
            <summary className="cursor-pointer text-[#5E6C84] hover:text-[#172B4D]">Show original failure output</summary>
            <pre className="mt-2 font-mono whitespace-pre-wrap overflow-auto max-h-48 bg-white border border-[#DFE1E6] p-2 rounded text-[#C9372C]">
              {testCase.originalFailureOutput}
            </pre>
            {testCase.originalScript && (
              <>
                <summary className="cursor-pointer text-[#5E6C84] hover:text-[#172B4D] mt-2">Show original script</summary>
                <pre className="mt-2 font-mono whitespace-pre-wrap overflow-auto max-h-64 bg-white border border-[#DFE1E6] p-2 rounded text-[#5E6C84]">
                  {testCase.originalScript}
                </pre>
              </>
            )}
          </details>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-[#DFE1E6] bg-[#F4F5F7]">
        {[['steps', 'Steps'], ['script', 'Script'], ['data', 'Test Data'], ['attempts', `Attempts (${attempts.length})`]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === key ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-[#8993A4] hover:text-[#5E6C84]'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-4 bg-[#FAFBFC]">
        {tab === 'steps' && (
          <div className="space-y-2">
            {(!testCase.steps || testCase.steps.length === 0)
              ? <p className="text-sm text-[#8993A4] italic">No steps recorded.</p>
              : testCase.steps.map((step, i) => (
                  <div key={i} className="flex gap-3 bg-[#FFFFFF] border border-[#DFE1E6] p-3 rounded">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-[10px] flex items-center justify-center font-bold">{i + 1}</span>
                    <div>
                      <p className="text-xs text-[#172B4D] font-medium">{step.action}</p>
                      {step.expectedResult && <p className="text-[10px] text-[#8993A4] italic mt-0.5">Expected: {step.expectedResult}</p>}
                    </div>
                  </div>
                ))
            }
            {testCase.codeFiles?.length > 0 && (
              <div className="mt-4">
                <p className="text-[10px] text-[#8993A4] uppercase tracking-wider mb-1 flex items-center gap-1"><GitBranch className="w-3 h-3"/>Covers</p>
                {testCase.codeFiles.map(f => (
                  <span key={f} className="block text-[11px] font-mono text-[#5E6C84] bg-[#F1F2F4] px-2 py-0.5 rounded mb-1">{f}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'script' && (
          testCase.testScript
            ? <pre className="text-xs text-[#5E6C84] font-mono whitespace-pre-wrap leading-relaxed">{testCase.testScript}</pre>
            : <p className="text-sm text-[#8993A4] italic">No script generated.</p>
        )}

        {tab === 'data' && (
          testCase.testData && Object.keys(testCase.testData).length > 0
            ? <pre className="text-xs text-[#5E6C84] font-mono whitespace-pre-wrap">{JSON.stringify(testCase.testData, null, 2)}</pre>
            : <p className="text-sm text-[#8993A4] italic">No test data.</p>
        )}

        {tab === 'attempts' && (
          <div className="space-y-2">
            {attempts.length === 0
              ? <p className="text-sm text-[#8993A4] italic">No attempt records yet.</p>
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
    <div className="flex items-center justify-center h-full text-[#5E6C84]">
      <Loader className="w-8 h-8 animate-spin" />
    </div>
  );

  if (error || !runData) return (
    <div className="p-8 text-center text-[#C9372C]">
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
  const prClassification = events.find(e => e.type === 'pr_classification')?.data || null;
  const isRunning = runData.status === 'running';
  const isFailed = runData.status === 'failed' || runData.status === 'error';
  const isCompleted = runData.status === 'completed';

  const toggleScenario = (id) => setExpandedScenarios(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="flex flex-col h-full space-y-4 max-w-full">
      {/* Back nav */}
      <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-2 text-[#8993A4] hover:text-[#172B4D] transition-colors text-sm">
        <ArrowLeft className="w-4 h-4" /> Back to Project
      </Link>

      {/* Run Header */}
      <div className="bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-mono text-[#5E6C84]">Run #{runId.substring(0, 8)}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${statusBadge(isCompleted ? 'pass' : isFailed ? 'fail' : 'running')}`}>
              {isCompleted ? 'Completed' : isFailed ? 'Failed' : 'Running'}
            </span>
            {isRunning && <Loader className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
            {prClassification?.isBugFix && (
              <span
                title={prClassification.rationale || 'Classified as a bug fix'}
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border font-semibold bg-[#EAE6FF] border-[#C0B6F2] text-[#5E4DB2]"
              >
                <ShieldAlert className="w-3 h-3" /> Regression Run
                {prClassification.source && <span className="opacity-70">· {prClassification.source}</span>}
              </span>
            )}
          </div>
          {prDetails.title && <p className="text-base font-bold text-[#172B4D]">{prDetails.title}</p>}
          {prDetails.branch && <p className="text-xs text-[#8993A4] mt-1 flex items-center gap-1"><GitBranch className="w-3 h-3"/>{prDetails.branch}</p>}
          {prClassification?.isBugFix && prClassification.rationale && (
            <p className="text-[11px] text-[#5E4DB2] mt-1 max-w-2xl">
              <span className="font-semibold">Why:</span> {prClassification.rationale}
            </p>
          )}
        </div>

        {/* Mini counters */}
        <div className="flex items-center gap-4 text-xs">
          {summary.scenarioCount > 0 && <span className="flex items-center gap-1 text-[#5E6C84]"><Activity className="w-3.5 h-3.5"/>{summary.scenarioCount} scenarios</span>}
          {summary.testCaseCount > 0 && <span className="flex items-center gap-1 text-[#5E6C84]"><ListChecks className="w-3.5 h-3.5"/>{summary.testCaseCount} cases</span>}
          {summary.passedCount > 0 && <span className="flex items-center gap-1 text-[#00875A]"><CheckCircle2 className="w-3.5 h-3.5"/>{summary.passedCount} passed</span>}
          {summary.failedCount > 0 && <span className="flex items-center gap-1 text-[#C9372C]"><XCircle className="w-3.5 h-3.5"/>{summary.failedCount} failed</span>}
          {summary.retryCount > 0 && <span className="flex items-center gap-1 text-orange-400"><RefreshCw className="w-3.5 h-3.5"/>{summary.retryCount} retries</span>}
        </div>
      </div>

      {/* Main content: scenario list + test case panel side-by-side */}
      <div className="flex flex-1 gap-4 min-h-0 overflow-hidden" style={{ minHeight: '520px' }}>
        {/* Left: Scenario list */}
        <div className="w-full md:w-[340px] flex-shrink-0 bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg overflow-y-auto">
          <div className="p-3 border-b border-[#DFE1E6]">
            <p className="text-xs font-bold text-[#5E6C84] uppercase tracking-wider">Scenarios & Test Cases</p>
          </div>

          {allScenarioIds.length === 0 ? (
            <div className="p-6 text-center text-[#8993A4] text-sm italic">
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
                      className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-[#F1F2F4] transition-colors text-left"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {statusIcon(sStatus?.status || (isRunning ? 'running' : 'pending'), 'w-3.5 h-3.5')}
                        <span className="text-xs font-mono text-indigo-300 truncate">{scenarioId}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {tcs.length > 0 && (
                          <span className="text-[10px] text-[#8993A4]">{tcs.filter(t => t.status === 'pass').length}/{tcs.length}</span>
                        )}
                        {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-[#8993A4]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#8993A4]" />}
                      </div>
                    </button>

                    {/* Test Cases under scenario */}
                    {isExpanded && (
                      <div className="bg-[#FAFBFC]">
                        {tcs.length === 0 ? (
                          <p className="px-4 py-2 text-[10px] text-[#8993A4] italic">
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
                                    : 'hover:bg-[#F1F2F4] border-transparent'
                                }`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {statusIcon(tc.status, 'w-3 h-3')}
                                  <div className="min-w-0">
                                    <p className="text-[10px] font-mono text-[#5E6C84] truncate">{tc.testCaseId}</p>
                                    <p className="text-[10px] text-[#8993A4] truncate">{tc.title}</p>
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
        <div className="flex-1 bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg overflow-hidden">
          {selectedTestCase ? (
            <TestCasePanel
              testCase={selectedTestCase}
              attempts={testCaseAttempts[selectedTestCase.testCaseId] || []}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-[#8993A4]">
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
