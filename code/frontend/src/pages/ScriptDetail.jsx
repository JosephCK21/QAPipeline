import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAppContext } from '../App';
import {
  ArrowLeft, AlertTriangle, Loader, CheckCircle2, XCircle, Clock,
  ChevronRight, ChevronDown, Code2, Database, ListChecks, RefreshCw,
  Activity, GitBranch, Terminal, ShieldAlert, Wrench, ImageIcon, Film
} from 'lucide-react';
import LiveBrowserPanel from '../components/LiveBrowserPanel';
import VideoPlayer from '../components/VideoPlayer';
import { getRunOutcomeCounts } from '../lib/runDisplayStatus';
import { normalizeStepForDisplay } from '../lib/stepDisplay';

const API_BASE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
  ? String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, '')
  : 'http://localhost:3001';

/** Dedupe by `url` — attempt events and disk media may reference the same artifact. */
function mergeVideosByUrl(fromAttempts, fromDisk) {
  const seen = new Set();
  const out = [];
  for (const v of [...(fromAttempts || []), ...(fromDisk || [])]) {
    const url = v?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** When `scenario_execution_updated` was overwritten in run events, fall back to DB test-case rows. */
function deriveScenarioRowStatus(sStatus, tcs, isRunActive) {
  if (sStatus?.status != null && String(sStatus.status).trim() !== '') {
    return String(sStatus.status).toLowerCase();
  }
  const list = Array.isArray(tcs) ? tcs : [];
  if (list.length === 0) {
    return isRunActive ? 'running' : 'pending';
  }
  const normalized = list.map((t) => String(t?.status || '').toLowerCase());
  if (normalized.some((x) => x === 'healing')) return 'healing';
  if (normalized.some((x) => x === 'running' || x === 'generating')) return 'running';
  if (normalized.length > 0 && normalized.every((x) => x === 'pass')) return 'pass';
  const hasFail = normalized.some((x) => x === 'fail' || x === 'final_fail');
  const hasPass = normalized.some((x) => x === 'pass');
  if (hasFail && hasPass) return 'partial';
  if (hasFail) return 'fail';
  return 'pending';
}

function statusColor(status, darkMode = false) {
  const s = String(status || '').toLowerCase();
  if (darkMode) {
    if (s === 'pass') return 'text-[#3FB950]';
    if (s === 'fail' || s === 'final_fail') return 'text-[#F85149]';
    if (s === 'healing') return 'text-[#58A6FF]';
    if (s === 'running') return 'text-[#D29922]';
    if (s === 'generating') return 'text-[#58A6FF]';
    if (s === 'partial') return 'text-orange-400';
    return 'text-[#8B949E]';
  }
  if (s === 'pass') return 'text-[#00875A]';
  if (s === 'fail' || s === 'final_fail') return 'text-[#C9372C]';
  if (s === 'healing') return 'text-[#0C66E4]';
  if (s === 'running') return 'text-[#B65C00]';
  if (s === 'generating') return 'text-indigo-400';
  if (s === 'partial') return 'text-orange-400';
  return 'text-[#5E6C84]';
}

function statusIcon(status, size = 'w-4 h-4', darkMode = false) {
  const s = String(status || '').toLowerCase();
  const sc = `${size} shrink-0`.trim();
  if (darkMode) {
    if (s === 'pass') return <CheckCircle2 className={`${sc} text-[#3FB950]`} />;
    if (s === 'fail' || s === 'final_fail') return <XCircle className={`${sc} text-[#F85149]`} />;
    if (s === 'healing') return <RefreshCw className={`${sc} text-[#58A6FF] animate-pulse`} />;
    if (s === 'running') return <Loader className={`${sc} text-[#D29922] animate-spin`} />;
    if (s === 'generating') return <Loader className={`${sc} text-[#58A6FF] animate-spin`} />;
    if (s === 'partial') return <AlertTriangle className={`${sc} text-orange-400`} />;
    return <Clock className={`${sc} text-[#6E7681]`} />;
  }
  if (s === 'pass') return <CheckCircle2 className={`${sc} text-[#00875A]`} />;
  if (s === 'fail' || s === 'final_fail') return <XCircle className={`${sc} text-[#C9372C]`} />;
  if (s === 'healing') return <RefreshCw className={`${sc} text-[#0C66E4] animate-pulse`} />;
  if (s === 'running') return <Loader className={`${sc} text-[#B65C00] animate-spin`} />;
  if (s === 'generating') return <Loader className={`${sc} text-indigo-400 animate-spin`} />;
  if (s === 'partial') return <AlertTriangle className={`${sc} text-orange-400`} />;
  return <Clock className={`${sc} text-[#8993A4]`} />;
}

function statusBadge(status, darkMode = false) {
  const s = String(status || '').toLowerCase();
  if (darkMode) {
    const map = {
      pass:       'bg-[rgba(63,185,80,0.15)] border-[rgba(63,185,80,0.3)] text-[#3FB950]',
      fail:       'bg-[rgba(248,81,73,0.15)] border-[rgba(248,81,73,0.3)] text-[#F85149]',
      final_fail: 'bg-[rgba(248,81,73,0.15)] border-[rgba(248,81,73,0.3)] text-[#F85149]',
      running:    'bg-[rgba(210,153,34,0.15)] border-[rgba(210,153,34,0.3)] text-[#D29922]',
      healing:    'bg-[rgba(56,139,253,0.15)] border-[rgba(56,139,253,0.3)] text-[#58A6FF]',
      generating: 'bg-[rgba(56,139,253,0.15)] border-[rgba(56,139,253,0.3)] text-[#58A6FF]',
      partial:    'bg-orange-500/15 border-orange-500/30 text-orange-300',
    };
    return map[s] || 'bg-[#30363D] border-[#30363D] text-[#8B949E]';
  }
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
function RegressionPill({ regression, darkMode = false }) {
  if (!regression || regression === 'clean_pass') return null;

  const styleMap = darkMode
    ? {
        adapted:         { cls: 'bg-[rgba(210,153,34,0.15)] border-[rgba(210,153,34,0.35)] text-[#D29922]', icon: <Wrench className="w-3 h-3" />,       label: 'Adapted' },
        regression_fail: { cls: 'bg-[rgba(248,81,73,0.12)] border-[rgba(248,81,73,0.35)] text-[#F85149]', icon: <ShieldAlert className="w-3 h-3" />, label: 'Regression' },
        pending:         { cls: 'bg-[rgba(56,139,253,0.12)] border-[rgba(56,139,253,0.35)] text-[#58A6FF]', icon: <RefreshCw className="w-3 h-3" />,    label: 'Regression run' }
      }
    : {
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
function AttemptRow({ attempt, darkMode = false }) {
  const [open, setOpen] = useState(false);
  const label = attempt.status === 'final_fail' ? `Attempt ${attempt.attempt} — Final Fail`
    : `Attempt ${attempt.attempt} — ${attempt.status === 'pass' ? 'Passed' : 'Failed'}`;

  const border = darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]';
  const rowBg = open
    ? (darkMode ? 'bg-[#21262D]' : 'bg-[#F4F5F7]')
    : (darkMode ? 'hover:bg-[#21262D]' : 'hover:bg-[#F1F2F4]');
  const expandBg = darkMode ? 'bg-[#161B22]' : 'bg-[#FAFBFC]';
  const muted = darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]';
  const labelMuted = darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]';

  return (
    <div className={`border ${border} rounded`}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded ${rowBg} transition-colors`}
      >
        <div className="flex items-center gap-2">
          {statusIcon(attempt.status, 'w-3.5 h-3.5', darkMode)}
          <span className={statusColor(attempt.status, darkMode)}>{label}</span>
          <RegressionPill regression={attempt.regression} darkMode={darkMode} />
          {attempt.startedAt && (
            <span className={`${muted} text-[10px]`}>{new Date(attempt.startedAt).toLocaleTimeString()}</span>
          )}
        </div>
        {open ? <ChevronDown className={`w-3.5 h-3.5 ${muted}`} /> : <ChevronRight className={`w-3.5 h-3.5 ${muted}`} />}
      </button>

      {open && (
        <div className={`px-3 pb-3 space-y-2 border-t ${border} ${expandBg} rounded-b`}>
          {attempt.failureScreenshots?.length > 0 && (
            <div className="mt-2">
              <p className={`text-[10px] ${labelMuted} uppercase tracking-wider mb-1 flex items-center gap-1`}>
                <ImageIcon className="w-3 h-3" /> Playwright failure screenshots
              </p>
              <div className="space-y-2">
                {attempt.failureScreenshots.map((s) => (
                  <a
                    key={s.url}
                    href={`${API_BASE}${s.url}`}
                    target="_blank"
                    rel="noreferrer"
                    className={`block rounded overflow-hidden hover:ring-2 ${
                      darkMode
                        ? 'border border-[#30363D] bg-[#1C2333] hover:ring-[#58A6FF]/40'
                        : 'border border-[#DFE1E6] bg-[#FFFFFF] hover:ring-indigo-400/40'
                    }`}
                  >
                    <img
                      src={`${API_BASE}${s.url}`}
                      alt={s.fileName || 'Failure screenshot'}
                      className="w-full max-h-64 object-contain bg-[#171717]"
                    />
                    <span className={`block text-[9px] px-2 py-1 truncate ${muted}`}>{s.fileName}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {attempt.traces?.length > 0 && (
            <div className="mt-2">
              <p className={`text-[10px] ${labelMuted} uppercase tracking-wider mb-1 flex items-center gap-1`}>
                <Film className="w-3 h-3" /> Trace files
              </p>
              <ul className={`text-[11px] space-y-1 ${darkMode ? 'text-[#58A6FF]' : 'text-indigo-500'}`}>
                {attempt.traces.map((t) => (
                  <li key={t.url}>
                    <a href={`${API_BASE}${t.url}`} download={t.fileName} className="hover:underline break-all">{t.fileName}</a>
                    <span className={`block text-[9px] mt-0.5 ${muted}`}>
                      Inspect locally with: <code className={`px-1 rounded text-[10px] ${darkMode ? 'bg-[#30363D] text-[#E6EDF3]' : 'bg-[#F4F5F7] text-[#172B4D]'}`}>npx playwright show-trace &lt;this-file.zip&gt;</code>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {attempt.failureOutput && (
            <div className="mt-2">
              <p className={`text-[10px] ${darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'} uppercase tracking-wider mb-1 flex items-center gap-1`}>
                <Terminal className="w-3 h-3" /> Failure Output
              </p>
              <pre className={`text-[10px] font-mono whitespace-pre-wrap overflow-auto max-h-48 p-2 rounded border ${
                darkMode
                  ? 'text-[#F85149] bg-[rgba(248,81,73,0.08)] border-[rgba(248,81,73,0.25)]'
                  : 'text-[#C9372C] bg-red-900/10 border-red-900/30'
              }`}>
                {attempt.failureOutput}
              </pre>
            </div>
          )}
          {attempt.scriptSnapshot && (
            <div className="mt-2">
              <p className={`text-[10px] ${labelMuted} uppercase tracking-wider mb-1 flex items-center gap-1`}>
                <Code2 className="w-3 h-3" /> Script Used in This Attempt
              </p>
              <pre className={`text-[10px] font-mono whitespace-pre-wrap overflow-auto max-h-64 p-2 rounded border ${
                darkMode
                  ? 'text-[#8B949E] bg-[#0D1117] border-[#30363D]'
                  : 'text-[#5E6C84] bg-[#F4F5F7] border-[#DFE1E6]'
              }`}>
                {attempt.scriptSnapshot}
              </pre>
            </div>
          )}
          {attempt.output && attempt.status === 'pass' && (
            <div className="mt-2">
              <p className={`text-[10px] ${darkMode ? 'text-[#3FB950]' : 'text-[#00875A]'} uppercase tracking-wider mb-1 flex items-center gap-1`}>
                <Terminal className="w-3 h-3" /> Sandbox Output
              </p>
              <pre className={`text-[10px] font-mono whitespace-pre-wrap overflow-auto max-h-48 p-2 rounded border ${
                darkMode
                  ? 'text-[#3FB950] bg-[rgba(63,185,80,0.08)] border-[rgba(63,185,80,0.25)]'
                  : 'text-[#00875A] bg-green-900/10 border-green-900/30'
              }`}>
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
// Test Case Detail Panel (scenario-adjacent column)
// ---------------------------------------------------------------------------
function TestCasePanel({ testCase, attempts, darkMode = false }) {
  const [tab, setTab] = useState('steps');
  const [diskMedia, setDiskMedia] = useState(null);
  const [diskMediaLoading, setDiskMediaLoading] = useState(false);
  const [diskMediaError, setDiskMediaError] = useState(null);

  const videosFromAttempts = useMemo(
    () => attempts.flatMap((att) => att.videos || []),
    [attempts]
  );
  const mergedVideos = useMemo(
    () => mergeVideosByUrl(videosFromAttempts, diskMedia?.videos),
    [videosFromAttempts, diskMedia]
  );

  useEffect(() => {
    if (tab !== 'video') {
      setDiskMedia(null);
      setDiskMediaLoading(false);
      setDiskMediaError(null);
      return;
    }
    const rid = testCase?.runId;
    const tcId = testCase?.testCaseId;
    if (!rid || !tcId) {
      setDiskMedia(null);
      setDiskMediaLoading(false);
      setDiskMediaError(null);
      return;
    }
    let cancelled = false;
    setDiskMedia(null);
    setDiskMediaLoading(true);
    setDiskMediaError(null);
    fetch(
      `${API_BASE}/api/runs/${encodeURIComponent(rid)}/test-cases/${encodeURIComponent(tcId)}/media`
    )
      .then((r) => {
        if (!r.ok) throw new Error(r.statusText || 'Failed to load media');
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setDiskMedia(data);
      })
      .catch((e) => {
        if (!cancelled) setDiskMediaError(e.message || 'Failed to load media');
      })
      .finally(() => {
        if (!cancelled) setDiskMediaLoading(false);
      });
    return () => { cancelled = true; };
  }, [tab, testCase?.runId, testCase?.testCaseId]);

  const hBorder = darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]';
  const headerBg = darkMode ? 'bg-[#161B22]' : 'bg-[#F4F5F7]';
  const primaryText = darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]';
  const muted = darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]';
  const tabBarBg = darkMode ? 'bg-[#161B22]' : 'bg-[#F4F5F7]';
  const contentBg = darkMode ? 'bg-[#0D1117]' : 'bg-[#FAFBFC]';
  const monoMuted = darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className={`p-4 border-b ${hBorder} ${headerBg}`}>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${statusBadge(testCase.status, darkMode)}`}>
            {testCase.status || 'pending'}
          </span>
          {testCase.version > 1 && (
            <span className="text-[9px] px-1.5 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{testCase.version}</span>
          )}
          {testCase.healAttempts > 0 && (
            <span
              title={`${testCase.healAttempts} heal attempt(s) (completed)`}
              className="text-[9px] flex items-center gap-0.5 text-orange-400"
            >
              <Wrench className="w-3.5 h-3.5 shrink-0" />
              {testCase.healAttempts} heal{testCase.healAttempts !== 1 ? 's' : ''}
            </span>
          )}
          {Number(testCase.heal_exhausted) === 1 && testCase.status === 'fail' && (
            <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold uppercase tracking-wide ${
              darkMode ? 'border-[rgba(248,81,73,0.4)] bg-[rgba(248,81,73,0.12)] text-[#F85149]' : 'border-red-500/45 bg-red-500/15 text-[#C9372C]'
            }`}>
              Heal exhausted
            </span>
          )}
          <RegressionPill regression={testCase.regression} darkMode={darkMode} />
          {(testCase.source === 'fallback' || testCase.scenarioId === 'FALLBACK') && (
            <span
              title="Auto-generated smoke test for files without Jira scenario coverage"
              className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                darkMode ? 'bg-[#30363D] border-[#484F58] text-[#8B949E]' : 'bg-[#EBECF0] border-[#C1C7D0] text-[#5E6C84]'
              }`}
            >
              smoke
            </span>
          )}
        </div>
        <p className={`text-xs font-mono ${darkMode ? 'text-[#58A6FF]' : 'text-indigo-400'}`}>{testCase.testCaseId}</p>
        <p className={`text-sm font-semibold ${primaryText} mt-0.5 leading-tight`}>{testCase.title}</p>
        {testCase.language && (
          <p className={`text-[10px] ${muted} mt-1 flex items-center gap-1`}>
            <Code2 className="w-3 h-3" />{testCase.language}
          </p>
        )}
      </div>

      {/* Regression banner — shown when the test case was adapted or failed in a regression run */}
      {(testCase.regression === 'adapted' || testCase.regression === 'regression_fail') && testCase.originalFailureOutput && (
        <div className={`px-4 py-3 border-b ${hBorder} ${
          testCase.regression === 'adapted'
            ? (darkMode ? 'bg-[rgba(210,153,34,0.08)] border-[rgba(210,153,34,0.25)]' : 'bg-[#FFF7D6] border-[#F8E08E]')
            : (darkMode ? 'bg-[rgba(248,81,73,0.08)] border-[rgba(248,81,73,0.25)]' : 'bg-[#FFEBE6] border-[#FFBDAD]')
        }`}>
          <p className={`text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1 mb-1 ${
            testCase.regression === 'adapted'
              ? (darkMode ? 'text-[#D29922]' : 'text-[#B65C00]')
              : (darkMode ? 'text-[#F85149]' : 'text-[#C9372C]')
          }`}>
            <ShieldAlert className="w-3 h-3" />
            {testCase.regression === 'adapted'
              ? 'Potential regression — original script failed, adapted version passed'
              : 'Regression failure — existing script could not be made green'}
          </p>
          <details className="text-[11px]">
            <summary className={`cursor-pointer ${monoMuted} ${darkMode ? 'hover:text-[#E6EDF3]' : 'hover:text-[#172B4D]'}`}>Show original failure output</summary>
            <pre className={`mt-2 font-mono whitespace-pre-wrap overflow-auto max-h-48 p-2 rounded border ${
              darkMode ? 'bg-[#161B22] border-[#30363D] text-[#F85149]' : 'bg-white border border-[#DFE1E6] text-[#C9372C]'
            }`}>
              {testCase.originalFailureOutput}
            </pre>
            {testCase.originalScript && (
              <>
                <summary className={`cursor-pointer ${monoMuted} ${darkMode ? 'hover:text-[#E6EDF3]' : 'hover:text-[#172B4D]'} mt-2`}>Show original script</summary>
                <pre className={`mt-2 font-mono whitespace-pre-wrap overflow-auto max-h-64 p-2 rounded border ${
                  darkMode ? 'bg-[#161B22] border-[#30363D] text-[#8B949E]' : 'bg-white border border-[#DFE1E6] text-[#5E6C84]'
                }`}>
                  {testCase.originalScript}
                </pre>
              </>
            )}
          </details>
        </div>
      )}

      {/* Tabs */}
      <div className={`flex border-b ${hBorder} ${tabBarBg}`}>
        {[['steps', 'Steps'], ['script', 'Script'], ['data', 'Test Data'], ['video', 'Video'], ['attempts', `Attempts (${attempts.length})`]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              tab === key
                ? (darkMode ? 'border-[#58A6FF] text-[#58A6FF]' : 'border-indigo-500 text-indigo-400')
                : (darkMode ? 'border-transparent text-[#6E7681] hover:text-[#8B949E]' : 'border-transparent text-[#8993A4] hover:text-[#5E6C84]')
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className={`flex-1 overflow-auto p-4 ${contentBg}`}>
        {tab === 'steps' && (
          <div className="space-y-2">
            {(!testCase.steps || testCase.steps.length === 0)
              ? <p className={`text-sm ${muted} italic`}>No steps recorded.</p>
              : testCase.steps.map((step, i) => {
                  const { action, expectedResult } = normalizeStepForDisplay(step);
                  return (
                    <div key={i} className={`flex gap-3 p-3 rounded border ${
                      darkMode ? 'bg-[#1C2333] border-[#30363D]' : 'bg-[#FFFFFF] border-[#DFE1E6]'
                    }`}>
                      <span className={`flex-shrink-0 w-5 h-5 rounded-full text-[10px] flex items-center justify-center font-bold ${
                        darkMode ? 'bg-[rgba(56,139,253,0.15)] border border-[rgba(56,139,253,0.35)] text-[#58A6FF]' : 'bg-indigo-500/20 border border-indigo-500/40 text-indigo-300'
                      }`}>{i + 1}</span>
                      <div className="min-w-0">
                        <p className={`text-xs font-medium ${primaryText}`}>{action || '—'}</p>
                        {expectedResult ? (
                          <p className={`text-[10px] ${muted} italic mt-0.5`}>Expected: {expectedResult}</p>
                        ) : null}
                      </div>
                    </div>
                  );
                })
            }
            {testCase.codeFiles?.length > 0 && (
              <div className="mt-4">
                <p className={`text-[10px] ${muted} uppercase tracking-wider mb-1 flex items-center gap-1`}><GitBranch className="w-3 h-3"/>Covers</p>
                {testCase.codeFiles.map(f => (
                  <span key={f} className={`block text-[11px] font-mono px-2 py-0.5 rounded mb-1 ${
                    darkMode ? 'text-[#8B949E] bg-[#30363D]' : 'text-[#5E6C84] bg-[#F1F2F4]'
                  }`}>{f}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'script' && (
          testCase.testScript
            ? <pre className={`text-xs font-mono whitespace-pre-wrap leading-relaxed ${monoMuted}`}>{testCase.testScript}</pre>
            : <p className={`text-sm ${muted} italic`}>No script generated.</p>
        )}

        {tab === 'data' && (
          testCase.testData && Object.keys(testCase.testData).length > 0
            ? <pre className={`text-xs font-mono whitespace-pre-wrap ${monoMuted}`}>{JSON.stringify(testCase.testData, null, 2)}</pre>
            : <p className={`text-sm ${muted} italic`}>No test data.</p>
        )}

        {tab === 'video' && (
          <div className="space-y-3">
            {diskMediaLoading && (
              <div className={`flex items-center gap-2 text-sm ${muted}`}>
                <Loader className="w-4 h-4 animate-spin shrink-0" />
                Loading media…
              </div>
            )}
            {diskMediaError && (
              <p className={`text-sm ${darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'}`}>{diskMediaError}</p>
            )}
            {!diskMediaLoading && (
              <VideoPlayer videos={mergedVideos} darkMode={darkMode} />
            )}
          </div>
        )}

        {tab === 'attempts' && (
          <div className="space-y-2">
            {attempts.length === 0
              ? <p className={`text-sm ${muted} italic`}>No attempt records yet.</p>
              : attempts.map((att, i) => <AttemptRow key={i} attempt={att} darkMode={darkMode} />)
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
  const { refreshKey, vncContainers, liveExecution, darkMode } = useAppContext();

  const vncContainersForRun = (vncContainers || []).filter((c) => c.runId === runId);
  const liveExecutionForRun =
    liveExecution && liveExecution.runId === runId ? liveExecution : null;
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
    <div className={`flex items-center justify-center h-full ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
      <Loader className="w-8 h-8 animate-spin" />
    </div>
  );

  if (error || !runData) return (
    <div className="p-8 text-center">
      <AlertTriangle className={`w-10 h-10 mx-auto mb-4 ${darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'}`} />
      <p className={darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'}>{error || 'No data available.'}</p>
      <Link to={`/projects/${projectId}`} className={`mt-4 inline-block hover:underline ${darkMode ? 'text-[#58A6FF]' : 'text-indigo-400'}`}>Return to Project</Link>
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

  // Test cases from _testCases endpoint (grouped by scenarioId) — build before allScenarioIds
  const tcByScenario = {};
  if (runData._testCases) {
    for (const tc of runData._testCases) {
      const sid = tc.scenarioId != null ? String(tc.scenarioId) : '';
      if (!sid) continue;
      if (!tcByScenario[sid]) tcByScenario[sid] = [];
      tcByScenario[sid].push(tc);
    }
  }
  const scenarioIdsFromDb = Object.keys(tcByScenario);

  // All scenario IDs we have data for (events + DB test cases so list is not empty when events were overwritten)
  const allScenarioIds = [...new Set([...mappedScenarioIds, ...Object.keys(scenarioStatuses), ...savedTcScenarioIds, ...scenarioIdsFromDb])];

  const runOutcomeCounts = getRunOutcomeCounts(runData);
  const headerScenarioCount = summary.scenarioCount > 0 ? summary.scenarioCount : allScenarioIds.length;
  const headerCaseCount = summary.testCaseCount > 0 ? summary.testCaseCount : runOutcomeCounts.total;
  const headerPassedCount = summary.passedCount > 0 ? summary.passedCount : runOutcomeCounts.passed;
  const headerFailedCount = summary.failedCount > 0 ? summary.failedCount : runOutcomeCounts.failed;

  const prDetails = events.find(e => e.type === 'pr_details')?.data || {};
  const prClassification = events.find(e => e.type === 'pr_classification')?.data || null;
  const isRunning = runData.status === 'running';
  const isFailed = runData.status === 'failed' || runData.status === 'error';
  const isCompleted = runData.status === 'completed';

  const toggleScenario = (id) => setExpandedScenarios(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="flex flex-col h-full space-y-4 max-w-full">
      {/* Back nav */}
      <Link to={`/projects/${projectId}`} className={`inline-flex items-center gap-2 transition-colors text-sm ${darkMode ? 'text-[#8B949E] hover:text-[#E6EDF3]' : 'text-[#8993A4] hover:text-[#172B4D]'}`}>
        <ArrowLeft className="w-4 h-4" /> Back to Project
      </Link>

      {/* Run Header */}
      <div className={`rounded-lg p-4 flex flex-wrap items-center justify-between gap-4 border ${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#F4F5F7] border-[#DFE1E6]'}`}>
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-sm font-mono ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>Run #{runId.substring(0, 8)}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${statusBadge(isCompleted ? 'pass' : isFailed ? 'fail' : 'running', darkMode)}`}>
              {isCompleted ? 'Completed' : isFailed ? 'Failed' : 'Running'}
            </span>
            {isRunning && <Loader className={`w-3.5 h-3.5 animate-spin ${darkMode ? 'text-[#58A6FF]' : 'text-blue-400'}`} />}
            {prClassification?.isBugFix && (
              <span
                title={prClassification.rationale || 'Classified as a bug fix'}
                className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border font-semibold ${
                  darkMode
                    ? 'bg-[rgba(88,166,255,0.12)] border-[rgba(88,166,255,0.35)] text-[#79C0FF]'
                    : 'bg-[#EAE6FF] border-[#C0B6F2] text-[#5E4DB2]'
                }`}
              >
                <ShieldAlert className="w-3 h-3" /> Regression Run
                {prClassification.source && <span className="opacity-70">· {prClassification.source}</span>}
              </span>
            )}
          </div>
          {prDetails.title && <p className={`text-base font-bold ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>{prDetails.title}</p>}
          {prDetails.branch && <p className={`text-xs mt-1 flex items-center gap-1 ${darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]'}`}><GitBranch className="w-3 h-3"/>{prDetails.branch}</p>}
          {prClassification?.isBugFix && prClassification.rationale && (
            <p className={`text-[11px] mt-1 max-w-2xl ${darkMode ? 'text-[#79C0FF]' : 'text-[#5E4DB2]'}`}>
              <span className="font-semibold">Why:</span> {prClassification.rationale}
            </p>
          )}
        </div>

        {/* Mini counters — summary event when present, else DB / derived counts */}
        <div className="flex items-center gap-4 text-xs">
          {headerScenarioCount > 0 && <span className={`flex items-center gap-1 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}><Activity className="w-3.5 h-3.5"/>{headerScenarioCount} scenarios</span>}
          {headerCaseCount > 0 && <span className={`flex items-center gap-1 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}><ListChecks className="w-3.5 h-3.5"/>{headerCaseCount} cases</span>}
          {headerPassedCount > 0 && <span className={`flex items-center gap-1 ${darkMode ? 'text-[#3FB950]' : 'text-[#00875A]'}`}><CheckCircle2 className="w-3.5 h-3.5"/>{headerPassedCount} passed</span>}
          {headerFailedCount > 0 && <span className={`flex items-center gap-1 ${darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'}`}><XCircle className="w-3.5 h-3.5"/>{headerFailedCount} failed</span>}
          {summary.retryCount > 0 && <span className="flex items-center gap-1 text-orange-400"><RefreshCw className="w-3.5 h-3.5"/>{summary.retryCount} retries</span>}
        </div>
      </div>

      {/* Main content: 3-column layout — scenario list + test case panel + live browser */}
      <div className="flex flex-1 gap-4 min-h-0 overflow-hidden" style={{ minHeight: '520px' }}>
        {/* Left: Scenario list */}
        <div className={`w-full md:w-[280px] flex-shrink-0 rounded-lg overflow-y-auto border ${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#F4F5F7] border-[#DFE1E6]'}`}>
          <div className={`p-3 border-b ${darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]'}`}>
            <p className={`text-xs font-bold uppercase tracking-wider ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>Scenarios & Test Cases</p>
          </div>

          {allScenarioIds.length === 0 ? (
            <div className={`p-6 text-center text-sm italic ${darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]'}`}>
              {isRunning ? 'Generating test cases…' : 'No scenarios or test cases found for this run.'}
            </div>
          ) : (
            <div className={darkMode ? 'divide-y divide-[#30363D]' : 'divide-y divide-[#DFE1E6]'}>
              {allScenarioIds.map(scenarioId => {
                const sStatus = scenarioStatuses[scenarioId];
                const isExpanded = !!expandedScenarios[scenarioId];
                const tcs = tcByScenario[scenarioId] || [];
                const scenarioRowStatus = deriveScenarioRowStatus(sStatus, tcs, isRunning);

                return (
                  <div key={scenarioId}>
                    {/* Scenario Row */}
                    <button
                      onClick={() => toggleScenario(scenarioId)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 transition-colors text-left ${
                        darkMode ? 'hover:bg-[#21262D]' : 'hover:bg-[#F1F2F4]'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {statusIcon(scenarioRowStatus, 'w-3.5 h-3.5', darkMode)}
                        <span className={`text-xs font-mono truncate ${darkMode ? 'text-[#58A6FF]' : 'text-indigo-300'}`}>{scenarioId}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {tcs.length > 0 && (
                          <span className={`text-[10px] ${darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]'}`}>{tcs.filter(t => t.status === 'pass').length}/{tcs.length}</span>
                        )}
                        {isExpanded ? <ChevronDown className={`w-3.5 h-3.5 ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`} /> : <ChevronRight className={`w-3.5 h-3.5 ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`} />}
                      </div>
                    </button>

                    {/* Test Cases under scenario */}
                    {isExpanded && (
                      <div className={darkMode ? 'bg-[#0D1117]' : 'bg-[#FAFBFC]'}>
                        {tcs.length === 0 ? (
                          <p className={`px-4 py-2 text-[10px] italic ${darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]'}`}>
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
                                    ? (darkMode ? 'bg-indigo-500/15 border-[#58A6FF]' : 'bg-indigo-500/10 border-indigo-500')
                                    : (darkMode ? 'hover:bg-[#161B22] border-transparent' : 'hover:bg-[#F1F2F4] border-transparent')
                                }`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {statusIcon(tc.status, 'w-3.5 h-3.5', darkMode)}
                                  <div className="min-w-0">
                                    <p className={`text-[10px] font-mono truncate ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>{tc.testCaseId}</p>
                                    <p className={`text-[10px] truncate ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`}>{tc.title}</p>
                                  </div>
                                </div>
                                <div className="flex-shrink-0 flex items-center gap-1">
                                  {tc.version > 1 && <span className="text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded border border-blue-500/30">v{tc.version}</span>}
                                  {tc.healAttempts > 0 && (
                                    <Wrench
                                      className="w-3.5 h-3.5 shrink-0 text-orange-400"
                                      title={`${tc.healAttempts} heal attempt(s) (completed)`}
                                      aria-label={`${tc.healAttempts} heal attempt(s) (completed)`}
                                    />
                                  )}
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

        {/* Middle: Test case detail */}
        <div className={`flex-1 lg:w-[380px] lg:flex-none rounded-lg overflow-hidden border ${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#F4F5F7] border-[#DFE1E6]'}`}>
          {selectedTestCase ? (
            <TestCasePanel
              testCase={selectedTestCase}
              attempts={testCaseAttempts[selectedTestCase.testCaseId] || []}
              darkMode={darkMode}
            />
          ) : (
            <div className={`flex flex-col items-center justify-center h-full ${darkMode ? 'text-[#8B949E]' : 'text-[#8993A4]'}`}>
              <ListChecks className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">Select a test case to see details</p>
              <p className="text-xs mt-1 opacity-70">Expand a scenario on the left to see its test cases</p>
            </div>
          )}
        </div>

        {/* Right: Live browser — flex-1 fills remaining width */}
        <div className="hidden lg:flex flex-1 min-w-0 w-full">
          <LiveBrowserPanel
            vncContainers={vncContainersForRun}
            currentExecution={liveExecutionForRun}
            isRunning={isRunning}
            darkMode={darkMode}
          />
        </div>
      </div>
    </div>
  );
}

export default ScriptDetail;
