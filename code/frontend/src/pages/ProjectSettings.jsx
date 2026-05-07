import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Activity,
  GitCommit,
  Settings as SettingsIcon,
  ArrowLeft,
  AlertTriangle,
  Plus,
  Trash2,
  Loader,
  ChevronDown,
  UserCircle,
  Eye,
  EyeOff,
  Lock
} from 'lucide-react';
import { useAppContext } from '../App';
import BranchPolicyMatrix from '../components/BranchPolicyMatrix';

const SANDBOX_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEST_ACCOUNT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const API_BASE = 'http://localhost:3001';

/** Collapsed-row email hint; full address only shown when expanded. */
function maskEmail(email) {
  const e = String(email || '').trim();
  if (!e) return null;
  const at = e.indexOf('@');
  if (at <= 0) return '•••';
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!local.length) return `•••@${domain}`;
  return `${local[0]}***@${domain}`;
}

function envObjectToRows(obj) {
  const e = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  return Object.entries(e).map(([key, value]) => ({ key, value: String(value ?? '') }));
}

function rowsToEnvObject(rows) {
  const out = {};
  for (const r of rows) {
    const k = String(r.key ?? '').trim();
    if (!k) continue;
    out[k] = String(r.value ?? '');
  }
  return out;
}

function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { showToast, refreshKey, darkMode } = useAppContext();
  
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // Integration settings state
  const [spaces, setSpaces] = useState([]);
  const [repos, setRepos] = useState([]);
  const [selectedJiraSpace, setSelectedJiraSpace] = useState('');
  const [selectedGithubRepo, setSelectedGithubRepo] = useState('');
  const [isLinkingJira, setIsLinkingJira] = useState(false);
  const [isLinkingGithub, setIsLinkingGithub] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [sandboxEnvRows, setSandboxEnvRows] = useState([]);
  const [sandboxEnvLoading, setSandboxEnvLoading] = useState(true);
  const [sandboxEnvSaving, setSandboxEnvSaving] = useState(false);

  const [testAccountsEnabled, setTestAccountsEnabled] = useState(false);
  const [testAccountsDefaultId, setTestAccountsDefaultId] = useState('');
  const [testAccountRows, setTestAccountRows] = useState([]);
  const [testAccountsLoading, setTestAccountsLoading] = useState(true);
  const [testAccountsSaving, setTestAccountsSaving] = useState(false);
  const [expandedTestAccountIndex, setExpandedTestAccountIndex] = useState(null);
  const [passwordVisibleForIndex, setPasswordVisibleForIndex] = useState(null);

  useEffect(() => {
    fetchProjectData();
    fetchIntegrations();
    loadSandboxEnv();
    loadDefaultTestAccounts();
  }, [projectId, refreshKey]);

  const fetchProjectData = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}`);
      if (!res.ok) throw new Error('Failed to fetch project');
      const data = await res.json();
      setProject(data);
      if (data.jiraProjectKey) setSelectedJiraSpace(data.jiraProjectKey);
      if (data.githubRepoFullName) setSelectedGithubRepo(data.githubRepoFullName);
    } catch (err) {
      console.error(err);
      showToast('Error loading project details', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchIntegrations = async () => {
    try {
      const [jiraRes, githubRes] = await Promise.all([
        fetch(`${API_BASE}/api/jira/spaces`),
        fetch(`${API_BASE}/api/github/repos`)
      ]);
      if (jiraRes.ok) setSpaces(await jiraRes.json());
      if (githubRes.ok) setRepos(await githubRes.json());
    } catch (error) {
      console.error('Failed to load integrations lists', error);
    }
  };

  const loadSandboxEnv = async () => {
    setSandboxEnvLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/sandbox-env`);
      if (!res.ok) throw new Error('Failed to load sandbox env');
      const data = await res.json();
      setSandboxEnvRows(envObjectToRows(data.env));
    } catch (err) {
      console.error(err);
      showToast('Could not load sandbox environment variables', 'error');
      setSandboxEnvRows([]);
    } finally {
      setSandboxEnvLoading(false);
    }
  };

  const handleSaveSandboxEnv = async () => {
    const seen = new Set();
    for (const r of sandboxEnvRows) {
      const k = String(r.key ?? '').trim();
      if (!k) continue;
      if (seen.has(k)) {
        showToast(`Duplicate key "${k}"`, 'error');
        return;
      }
      seen.add(k);
    }
    const env = rowsToEnvObject(sandboxEnvRows);
    for (const k of Object.keys(env)) {
      if (k.startsWith('AUTOQA_')) {
        showToast('Keys may not start with AUTOQA_ (reserved for the harness).', 'error');
        return;
      }
      if (!SANDBOX_KEY_RE.test(k)) {
        showToast(`Invalid key "${k}": use letters, digits, underscore; first character letter or underscore.`, 'error');
        return;
      }
    }
    try {
      setSandboxEnvSaving(true);
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/sandbox-env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env })
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || errBody.details?.[0]?.message || 'Save failed');
      }
      const data = await res.json();
      setSandboxEnvRows(envObjectToRows(data.env));
      showToast('Sandbox environment saved', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to save sandbox env', 'error');
    } finally {
      setSandboxEnvSaving(false);
    }
  };

  const handleClearSandboxEnv = async () => {
    if (!window.confirm('Remove all sandbox environment variables for this project?')) return;
    try {
      setSandboxEnvSaving(true);
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/sandbox-env`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Clear failed');
      setSandboxEnvRows([]);
      showToast('Sandbox environment cleared', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to clear sandbox env', 'error');
    } finally {
      setSandboxEnvSaving(false);
    }
  };

  const loadDefaultTestAccounts = async () => {
    setTestAccountsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/default-test-accounts`);
      if (!res.ok) throw new Error('Failed to load test accounts');
      const data = await res.json();
      setTestAccountsEnabled(!!data.enabled);
      setTestAccountsDefaultId(data.defaultAccountId || '');
      setTestAccountRows((data.accounts || []).map((a) => ({
        id: a.id || '',
        label: a.label || '',
        email: a.email || '',
        password: '',
        displayName: a.displayName || '',
        passwordSet: !!a.passwordSet
      })));
      setExpandedTestAccountIndex(null);
      setPasswordVisibleForIndex(null);
    } catch (err) {
      console.error(err);
      showToast('Could not load default test accounts', 'error');
      setTestAccountRows([]);
      setExpandedTestAccountIndex(null);
      setPasswordVisibleForIndex(null);
    } finally {
      setTestAccountsLoading(false);
    }
  };

  const handleSaveTestAccounts = async () => {
    const rows = testAccountRows.filter((r) => String(r.id || '').trim());
    for (const r of rows) {
      const id = String(r.id || '').trim();
      if (!TEST_ACCOUNT_ID_RE.test(id)) {
        showToast(
          `Invalid account id "${id}". Start with a letter; use only letters, digits, and underscores.`,
          'error'
        );
        return;
      }
    }
    const seen = new Set();
    for (const r of rows) {
      const id = String(r.id || '').trim();
      if (seen.has(id)) {
        showToast(`Duplicate account id "${id}"`, 'error');
        return;
      }
      seen.add(id);
    }
    if (testAccountsEnabled) {
      if (rows.length === 0) {
        showToast('Add at least one account when default test accounts are enabled.', 'error');
        return;
      }
      for (const r of rows) {
        const id = String(r.id || '').trim();
        if (!String(r.email || '').trim()) {
          showToast(`Account "${id}" needs an email.`, 'error');
          return;
        }
        if (!r.passwordSet && !String(r.password || '').trim()) {
          showToast(`Account "${id}" needs a password.`, 'error');
          return;
        }
      }
      if (rows.length > 1) {
        const def = String(testAccountsDefaultId || '').trim();
        if (!def || !rows.some((r) => String(r.id).trim() === def)) {
          showToast('Choose the default account for generic testData.login / testData.user.', 'error');
          return;
        }
      }
    }

    const payload = {
      enabled: testAccountsEnabled,
      defaultAccountId:
        rows.length > 1 ? (String(testAccountsDefaultId || '').trim() || null) : rows[0] ? String(rows[0].id).trim() : null,
      accounts: rows.map((r) => ({
        id: String(r.id || '').trim(),
        label: String(r.label || ''),
        email: String(r.email || ''),
        password: String(r.password || ''),
        displayName: String(r.displayName || '')
      }))
    };

    try {
      setTestAccountsSaving(true);
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/default-test-accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Save failed');
      }
      await loadDefaultTestAccounts();
      showToast('Default test accounts saved', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to save test accounts', 'error');
    } finally {
      setTestAccountsSaving(false);
    }
  };

  const handleClearTestAccounts = async () => {
    if (!window.confirm('Remove all default test accounts for this project?')) return;
    try {
      setTestAccountsSaving(true);
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/default-test-accounts`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Clear failed');
      setTestAccountsEnabled(false);
      setTestAccountsDefaultId('');
      setTestAccountRows([]);
      setExpandedTestAccountIndex(null);
      setPasswordVisibleForIndex(null);
      showToast('Default test accounts cleared', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to clear test accounts', 'error');
    } finally {
      setTestAccountsSaving(false);
    }
  };

  const handleLinkJira = async () => {
      try {
          setIsLinkingJira(true);
          const space = spaces.find(s => s.key === selectedJiraSpace);
          const res = await fetch(`${API_BASE}/api/projects/${projectId}/jira-link`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jiraProjectKey: space?.key, jiraProjectName: space?.name })
          });
          if (!res.ok) throw new Error('Failed to link Jira space');
          showToast('Successfully linked Jira space', 'success');
          fetchProjectData();
      } catch (err) {
          showToast(err.message, 'error');
      } finally {
          setIsLinkingJira(false);
      }
  };

  const handleLinkGithub = async () => {
      try {
          setIsLinkingGithub(true);
          const res = await fetch(`${API_BASE}/api/projects/${projectId}/github-link`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ githubRepoFullName: selectedGithubRepo })
          });
          if (!res.ok) throw new Error('Failed to link GitHub repo');
          showToast('Successfully linked GitHub repository', 'success');
          fetchProjectData();
      } catch (err) {
          showToast(err.message, 'error');
      } finally {
          setIsLinkingGithub(false);
      }
  };

  const handleDeleteProject = async () => {
      try {
          setIsDeleting(true);
          const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
              method: 'DELETE'
          });
          if (!res.ok) {
              const data = await res.json();
              throw new Error(data.error || 'Failed to delete project');
          }
          showToast('Project deleted successfully', 'success');
          navigate('/');
      } catch (err) {
          showToast(err.message, 'error');
          setIsDeleting(false);
          setShowDeleteConfirm(false);
      }
  };

  const toggleTestAccountExpand = (idx) => {
    setExpandedTestAccountIndex((cur) => (cur === idx ? null : idx));
    setPasswordVisibleForIndex(null);
  };

  const removeTestAccountAt = (idx) => {
    setTestAccountRows((rows) => rows.filter((_, i) => i !== idx));
    setExpandedTestAccountIndex((cur) => {
      if (cur === null) return null;
      if (cur === idx) return null;
      if (cur > idx) return cur - 1;
      return cur;
    });
    setPasswordVisibleForIndex((cur) => {
      if (cur === null) return null;
      if (cur === idx) return null;
      if (cur > idx) return cur - 1;
      return cur;
    });
  };

  useEffect(() => {
    if (expandedTestAccountIndex === null) return;
    const row = testAccountRows[expandedTestAccountIndex];
    if (!row || String(row.id || '').trim()) return;
    const handle = requestAnimationFrame(() => {
      document.getElementById(`test-account-id-${expandedTestAccountIndex}`)?.focus();
    });
    return () => cancelAnimationFrame(handle);
  }, [expandedTestAccountIndex, testAccountRows]);

  const ui = {
    panel: darkMode ? 'bg-[#161B22] border border-[#30363D]' : 'bg-[#F4F5F7] border border-[#DFE1E6]',
    heading: darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]',
    body: darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]',
    subtle: darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]',
    input: darkMode
      ? 'bg-[#0D1117] border border-[#30363D] text-[#E6EDF3] placeholder:text-[#6E7681]'
      : 'bg-white border border-[#C1C7D0] text-[#172B4D]',
    select: darkMode
      ? 'bg-[#0D1117] border border-[#30363D] text-[#E6EDF3]'
      : 'bg-[#F1F2F4] border border-[#C1C7D0] text-[#5E6C84]',
    chkInput: darkMode
      ? 'rounded border-[#30363D] bg-[#0D1117] text-indigo-400'
      : 'rounded border-[#C1C7D0]',
    code: darkMode ? 'bg-[#21262D] text-[#8B949E]' : 'bg-[#EBECF0] text-[#172B4D]',
    btnSecondary: darkMode
      ? 'bg-[#21262D] hover:bg-[#30363D] text-[#E6EDF3]'
      : 'bg-[#DFE1E6] hover:bg-[#C1C7D0] text-[#172B4D]',
    accountBox: darkMode ? 'border border-[#30363D] bg-[#0D1117]' : 'border border-[#DFE1E6] bg-[#FAFBFC]',
    dangerPanel: darkMode ? 'bg-[#220f0f] border border-[#f85149]/35' : 'bg-[#FFEBE6] border border-[#FFBDAD]',
    dangerHeading: darkMode ? 'text-[#ff7b72]' : 'text-red-500',
    backLink: darkMode ? 'text-[#58A6FF] hover:text-[#79B8FF]' : 'text-indigo-600 hover:text-indigo-700',
    ghostBtn: darkMode ? 'text-[#8B949E] hover:text-[#ff7b72]' : 'text-[#5E6C84] hover:text-[#C9372C]',
    cancelBtn: darkMode ? 'bg-[#21262D] hover:bg-[#30363D] text-[#E6EDF3]' : 'bg-[#F1F2F4] hover:bg-[#DFE1E6] text-[#5E6C84]',
    chkLabel: darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]',
    confirmBar: darkMode ? 'bg-[#0D1117] border border-[#f85149]/35' : 'bg-black/30 border border-[#FFBDAD]',
    iconBtn: darkMode ? 'text-[#8B949E] hover:text-[#ff7b72]' : 'text-[#5E6C84] hover:text-[#C9372C]',
    accountSummaryHover: darkMode ? 'hover:bg-[#21262D]/80' : 'hover:bg-[#EFF1F3]',
    badgeDefault: darkMode
      ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
      : 'bg-indigo-50 text-indigo-700 border border-indigo-200',
    badgeMuted: darkMode
      ? 'bg-[#21262D] text-[#8B949E] border border-[#30363D]'
      : 'bg-[#EBECF0] text-[#5E6C84] border border-[#DFE1E6]'
  };

  if (loading) {
    return <div className={`p-8 ${ui.body}`}>Loading project settings...</div>;
  }

  return (
    <div className="space-y-6 relative overflow-hidden h-full">
      {/* Header Info */}
      <div className={`flex justify-between items-start ${ui.panel} p-6 rounded-lg`}>
        <div>
          <button 
            onClick={() => navigate(`/projects/${projectId}`)}
            className={`flex items-center text-sm mb-4 transition-colors ${ui.backLink}`}
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400 mb-2 flex items-center">
            <SettingsIcon className="w-6 h-6 mr-2 text-indigo-400" />
            Project Settings
          </h1>
          <div className={`flex space-x-4 text-sm ${ui.body}`}>
            {project?.jiraProjectKey && (
              <span className="flex items-center"><Activity className="w-4 h-4 mr-1 text-blue-500" /> Jira: {project.jiraProjectKey}</span>
            )}
            {project?.githubRepoFullName && (
              <span className="flex items-center"><GitCommit className="w-4 h-4 mr-1 text-purple-500" /> GitHub: {project.githubRepoFullName}</span>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-6">
           {/* Integrations Panel */}
           <div className={`${ui.panel} rounded-lg p-6`}>
               <h3 className={`text-lg font-medium mb-4 ${ui.heading}`}>Integrations</h3>
               <div className="space-y-6">
                   <div className="flex flex-col md:flex-row md:items-center space-y-4 md:space-y-0 md:space-x-4">
                       <div className="w-full md:w-1/3">
                           <label className={`block text-sm font-medium mb-1 ${ui.body}`}>Jira Space</label>
                           <select
                               className={`w-full rounded-md py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${ui.select}`}
                               value={selectedJiraSpace || ''}
                               onChange={(e) => setSelectedJiraSpace(e.target.value)}
                           >
                               <option value="">Select a Jira Space</option>
                               {spaces.map(s => (
                                   <option key={s.key} value={s.key}>{s.name} ({s.key})</option>
                               ))}
                           </select>
                       </div>
                       <div className="pt-6 flex items-center">
                           <button
                               onClick={handleLinkJira}
                               disabled={isLinkingJira || !selectedJiraSpace || selectedJiraSpace === project?.jiraProjectKey}
                               className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-sm font-medium transition-colors h-10"
                           >
                               {isLinkingJira ? 'Linking...' : (selectedJiraSpace === project?.jiraProjectKey ? 'Linked' : 'Link Space')}
                           </button>
                       </div>
                   </div>
                   
                   <div className="flex flex-col md:flex-row md:items-center space-y-4 md:space-y-0 md:space-x-4">
                       <div className="w-full md:w-1/3">
                           <label className={`block text-sm font-medium mb-1 ${ui.body}`}>GitHub Repository</label>
                           <select
                               className={`w-full rounded-md py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${ui.select}`}
                               value={selectedGithubRepo || ''}
                               onChange={(e) => setSelectedGithubRepo(e.target.value)}
                           >
                               <option value="">Select a Repository</option>
                               {repos.map(r => (
                                   <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                               ))}
                           </select>
                       </div>
                       <div className="pt-6 flex items-center">
                           <button
                               onClick={handleLinkGithub}
                               disabled={isLinkingGithub || !selectedGithubRepo || selectedGithubRepo === project?.githubRepoFullName}
                               className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-sm font-medium transition-colors h-10"
                           >
                               {isLinkingGithub ? 'Linking...' : (selectedGithubRepo === project?.githubRepoFullName ? 'Linked' : 'Link Repository')}
                           </button>
                       </div>
                   </div>
               </div>
           </div>

           <div className={`${ui.panel} rounded-lg p-6`}>
              <h3 className={`text-lg font-medium mb-4 ${ui.heading}`}>Pipeline Execution Behaviors</h3>
              <BranchPolicyMatrix darkMode={darkMode} />
           </div>

           <div className={`${ui.panel} rounded-lg p-6`}>
              <h3 className={`text-lg font-medium mb-2 ${ui.heading}`}>Sandbox environment variables</h3>
              <p className={`text-sm mb-4 ${ui.body}`}>
                Injected into the PR sandbox Docker container at startup (<code className={`text-xs px-1 rounded ${ui.code}`}>docker run -e</code>
                ), so the dev server, Jest, Playwright, and pytest all see them. Values are not committed to git; they live on the server under{' '}
                <code className={`text-xs px-1 rounded ${ui.code}`}>data/sandbox-env/</code>.
                Keys starting with <code className={`text-xs px-1 rounded ${ui.code}`}>AUTOQA_</code> are reserved and cannot be set here.
              </p>
              {sandboxEnvLoading ? (
                <div className={`flex items-center gap-2 text-sm py-4 ${ui.body}`}>
                  <Loader className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  <div className="space-y-2 mb-4">
                    {sandboxEnvRows.length === 0 ? (
                      <p className={`text-sm italic py-2 ${ui.subtle}`}>No variables yet. Add a row or save an empty list to clear the file.</p>
                    ) : (
                      sandboxEnvRows.map((row, idx) => (
                        <div key={idx} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                          <input
                            type="text"
                            placeholder="VAR_NAME"
                            value={row.key}
                            onChange={(e) => {
                              const next = sandboxEnvRows.slice();
                              next[idx] = { ...next[idx], key: e.target.value };
                              setSandboxEnvRows(next);
                            }}
                            className={`flex-1 min-w-0 rounded-md py-2 px-3 text-sm font-mono ${ui.input}`}
                          />
                          <input
                            type="text"
                            placeholder="value"
                            value={row.value}
                            onChange={(e) => {
                              const next = sandboxEnvRows.slice();
                              next[idx] = { ...next[idx], value: e.target.value };
                              setSandboxEnvRows(next);
                            }}
                            className={`flex-[2] min-w-0 rounded-md py-2 px-3 text-sm font-mono ${ui.input}`}
                          />
                          <button
                            type="button"
                            onClick={() => setSandboxEnvRows(sandboxEnvRows.filter((_, i) => i !== idx))}
                            className={`p-2 rounded-md border border-transparent transition-colors shrink-0 ${ui.iconBtn} hover:border-[#C9372C]/30`}
                            title="Remove row"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSandboxEnvRows([...sandboxEnvRows, { key: '', value: '' }])}
                      className={`inline-flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${ui.btnSecondary}`}
                    >
                      <Plus className="w-4 h-4" /> Add variable
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveSandboxEnv}
                      disabled={sandboxEnvSaving}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors"
                    >
                      {sandboxEnvSaving ? <Loader className="w-4 h-4 animate-spin" /> : null}
                      Save sandbox env
                    </button>
                    <button
                      type="button"
                      onClick={handleClearSandboxEnv}
                      disabled={sandboxEnvSaving || sandboxEnvRows.length === 0}
                      className={`px-3 py-2 text-sm disabled:opacity-50 ${ui.ghostBtn}`}
                    >
                      Clear all
                    </button>
                  </div>
                </>
              )}
           </div>

           <div className={`${ui.panel} rounded-lg p-6`}>
             <h3 className={`text-lg font-medium mb-2 ${ui.heading}`}>Default test accounts</h3>
             <p className={`text-sm mb-4 ${ui.body}`}>
               Credentials used in generated Playwright/tests as <code className={`text-xs px-1 rounded ${ui.code}`}>testData.&lt;id&gt;</code> (email, password).
               Stored under <code className={`text-xs px-1 rounded ${ui.code}`}>data/default-test-accounts/</code> — not for API keys; use Sandbox env above for Supabase keys and URLs.
             </p>
             <label className={`flex items-center gap-2 text-sm mb-4 cursor-pointer ${ui.chkLabel}`}>
               <input
                 type="checkbox"
                 checked={testAccountsEnabled}
                 onChange={(e) => setTestAccountsEnabled(e.target.checked)}
                 className={ui.chkInput}
               />
               Use these accounts in the PR pipeline (generation + inferred testData)
             </label>
             {testAccountsLoading ? (
               <div className={`flex items-center gap-2 text-sm py-4 ${ui.body}`}>
                 <Loader className="w-4 h-4 animate-spin" /> Loading…
               </div>
             ) : (
               <>
                 {testAccountRows.filter((r) => String(r.id || '').trim()).length > 1 && (
                   <div className="mb-4 max-w-md">
                     <label className={`block text-sm font-medium mb-1 ${ui.body}`}>Default account (for generic testData.login / testData.user)</label>
                     <select
                       className={`w-full rounded-md py-2 px-3 text-sm ${ui.select}`}
                       value={testAccountsDefaultId}
                       onChange={(e) => setTestAccountsDefaultId(e.target.value)}
                     >
                       <option value="">Select…</option>
                       {testAccountRows
                         .filter((r) => String(r.id || '').trim())
                         .map((r) => (
                           <option key={r.id} value={String(r.id).trim()}>
                             {String(r.id).trim()}
                             {r.label ? ` — ${r.label}` : ''}
                           </option>
                         ))}
                     </select>
                   </div>
                 )}
                 <div className="space-y-2 mb-4">
                   {testAccountRows.length === 0 ? (
                     <p className={`text-sm italic py-2 ${ui.subtle}`}>No accounts. Add rows, then Save.</p>
                   ) : (
                     testAccountRows.map((row, idx) => {
                       const trimmedId = String(row.id || '').trim();
                       const summaryTitle = trimmedId || 'New account';
                       const expanded = expandedTestAccountIndex === idx;
                       const emailMasked = maskEmail(row.email);
                       const idMatchesDefault =
                         trimmedId &&
                         trimmedId === String(testAccountsDefaultId || '').trim();
                       const savedPasswordPlaceholder =
                         row.passwordSet && !String(row.password || '').trim();
                       const panelBorder = darkMode ? 'border-[#30363D]' : 'border-[#DFE1E6]';

                       return (
                         <div
                           key={idx}
                           className={`rounded-xl overflow-hidden transition-shadow ${ui.accountBox} ${expanded ? 'ring-1 ring-indigo-500/30' : ''}`}
                         >
                           <div className="flex items-stretch">
                             <button
                               type="button"
                               id={`test-acc-trigger-${idx}`}
                               aria-expanded={expanded}
                               aria-controls={`test-acc-panel-${idx}`}
                               onClick={() => toggleTestAccountExpand(idx)}
                               className={`flex-1 flex items-center gap-3 py-3 pl-3 pr-2 text-left min-w-0 transition-colors rounded-none ${ui.accountSummaryHover}`}
                             >
                               <ChevronDown
                                 className={`w-5 h-5 shrink-0 transition-transform duration-200 ${ui.subtle} ${expanded ? 'rotate-180' : ''}`}
                                 aria-hidden
                               />
                               <UserCircle className={`w-5 h-5 shrink-0 ${ui.body}`} aria-hidden />
                               <span className="min-w-0 flex-1">
                                 <span className={`font-mono text-sm font-semibold block truncate ${trimmedId ? ui.heading : ui.subtle}`}>
                                   {summaryTitle}
                                 </span>
                                 <span className={`text-xs mt-0.5 block truncate ${ui.subtle}`}>
                                   {emailMasked == null ? 'No email yet' : emailMasked}
                                 </span>
                                 <span className="flex sm:hidden flex-wrap gap-1.5 mt-1.5">
                                   {row.label && String(row.label).trim() && (
                                     <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${ui.badgeMuted}`}>
                                       {String(row.label).trim()}
                                     </span>
                                   )}
                                   {idMatchesDefault && (
                                     <span className={`text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full ${ui.badgeDefault}`}>
                                       Default
                                     </span>
                                   )}
                                   {savedPasswordPlaceholder && (
                                     <span className={`inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full ${ui.badgeMuted}`}>
                                       <Lock className="w-3 h-3" aria-hidden />
                                       Password on file
                                     </span>
                                   )}
                                 </span>
                               </span>
                               <span className="hidden sm:flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                                 {row.label && String(row.label).trim() && (
                                   <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${ui.badgeMuted}`}>
                                     {String(row.label).trim()}
                                   </span>
                                 )}
                                 {idMatchesDefault && (
                                   <span className={`text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full ${ui.badgeDefault}`}>
                                     Default
                                   </span>
                                 )}
                                 {savedPasswordPlaceholder && (
                                   <span className={`inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full ${ui.badgeMuted}`}>
                                     <Lock className="w-3 h-3" aria-hidden />
                                     Password on file
                                   </span>
                                 )}
                               </span>
                             </button>
                             <div className="flex items-center pr-2">
                               <button
                                 type="button"
                                 onClick={() => removeTestAccountAt(idx)}
                                 className={`p-2 rounded-md border border-transparent transition-colors shrink-0 ${ui.iconBtn} hover:border-[#C9372C]/30`}
                                 title="Remove account"
                               >
                                 <Trash2 className="w-4 h-4" />
                               </button>
                             </div>
                           </div>
                           <div
                             id={`test-acc-panel-${idx}`}
                             role="region"
                             aria-labelledby={`test-acc-trigger-${idx}`}
                             hidden={!expanded}
                             className={
                               expanded
                                 ? `border-t ${panelBorder} px-3 py-4 space-y-3 transition-opacity duration-200`
                                 : 'hidden'
                             }
                           >
                             <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                               <input
                                 id={`test-account-id-${idx}`}
                                 type="text"
                                 placeholder="id (e.g. admin)"
                                 title="Letters, digits, underscore; must start with a letter"
                                 value={row.id}
                                 onChange={(e) => {
                                   const next = testAccountRows.slice();
                                   next[idx] = { ...next[idx], id: e.target.value };
                                   setTestAccountRows(next);
                                 }}
                                 className={`rounded-md py-2 px-3 text-sm font-mono ${ui.input}`}
                               />
                               <input
                                 type="text"
                                 placeholder="Label (optional)"
                                 value={row.label}
                                 onChange={(e) => {
                                   const next = testAccountRows.slice();
                                   next[idx] = { ...next[idx], label: e.target.value };
                                   setTestAccountRows(next);
                                 }}
                                 className={`rounded-md py-2 px-3 text-sm ${ui.input}`}
                               />
                               <input
                                 type="email"
                                 placeholder="Email"
                                 autoComplete="off"
                                 value={row.email}
                                 onChange={(e) => {
                                   const next = testAccountRows.slice();
                                   next[idx] = { ...next[idx], email: e.target.value };
                                   setTestAccountRows(next);
                                 }}
                                 className={`rounded-md py-2 px-3 text-sm ${ui.input}`}
                               />
                             </div>
                             <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-start">
                               <div>
                                 <div className="relative">
                                   <input
                                     type={passwordVisibleForIndex === idx ? 'text' : 'password'}
                                     placeholder={
                                       row.passwordSet ? 'Password (leave blank to keep)' : 'Password'
                                     }
                                     autoComplete="new-password"
                                     value={row.password}
                                     onChange={(e) => {
                                       const next = testAccountRows.slice();
                                       next[idx] = { ...next[idx], password: e.target.value };
                                       setTestAccountRows(next);
                                     }}
                                     className={`w-full rounded-md py-2 pl-3 pr-10 text-sm ${ui.input}`}
                                   />
                                   <button
                                     type="button"
                                     aria-label={
                                       passwordVisibleForIndex === idx ? 'Hide password' : 'Show password'
                                     }
                                     onClick={() =>
                                       setPasswordVisibleForIndex(
                                         passwordVisibleForIndex === idx ? null : idx
                                       )
                                     }
                                     className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md ${ui.body} hover:bg-black/10 dark:hover:bg-white/10`}
                                   >
                                     {passwordVisibleForIndex === idx ? (
                                       <EyeOff className="w-4 h-4" aria-hidden />
                                     ) : (
                                       <Eye className="w-4 h-4" aria-hidden />
                                     )}
                                   </button>
                                 </div>
                                 {savedPasswordPlaceholder && (
                                   <p className={`text-xs mt-1.5 ${ui.subtle}`}>
                                     Password is stored; enter a new one to replace.
                                   </p>
                                 )}
                               </div>
                               <input
                                 type="text"
                                 placeholder="Display name (optional)"
                                 value={row.displayName}
                                 onChange={(e) => {
                                   const next = testAccountRows.slice();
                                   next[idx] = { ...next[idx], displayName: e.target.value };
                                   setTestAccountRows(next);
                                 }}
                                 className={`rounded-md py-2 px-3 text-sm ${ui.input}`}
                               />
                             </div>
                           </div>
                         </div>
                       );
                     })
                   )}
                 </div>
                 <div className="flex flex-wrap items-center gap-2">
                   <button
                     type="button"
                     onClick={() => {
                       setTestAccountRows((rows) => {
                         const next = [
                           ...rows,
                           {
                             id: '',
                             label: '',
                             email: '',
                             password: '',
                             displayName: '',
                             passwordSet: false
                           }
                         ];
                         setExpandedTestAccountIndex(next.length - 1);
                         setPasswordVisibleForIndex(null);
                         return next;
                       });
                     }}
                     className={`inline-flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${ui.btnSecondary}`}
                   >
                     <Plus className="w-4 h-4" /> Add account
                   </button>
                   <button
                     type="button"
                     onClick={handleSaveTestAccounts}
                     disabled={testAccountsSaving}
                     className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors"
                   >
                     {testAccountsSaving ? <Loader className="w-4 h-4 animate-spin" /> : null}
                     Save test accounts
                   </button>
                   <button
                     type="button"
                     onClick={handleClearTestAccounts}
                     disabled={testAccountsSaving || testAccountRows.length === 0}
                     className={`px-3 py-2 text-sm disabled:opacity-50 ${ui.ghostBtn}`}
                   >
                     Clear all
                   </button>
                 </div>
               </>
             )}
           </div>

           {/* Danger Zone */}
           <div className={`${ui.dangerPanel} rounded-lg p-6 mt-10`}>
              <h3 className={`text-lg font-medium mb-2 flex items-center ${ui.dangerHeading}`}>
                  <AlertTriangle className="w-5 h-5 mr-2" />
                  Danger Zone
              </h3>
              <p className={`text-sm mb-6 ${ui.body}`}>
                  Deleting this project will permanently remove all linked integrations, downloaded RTM baselines, execution histories, uploaded documents, and metrics. This action is irreversible.
              </p>
              
              {!showDeleteConfirm ? (
                  <button
                      onClick={() => setShowDeleteConfirm(true)}
                      className="px-4 py-2 bg-[#C9372C] hover:bg-red-700 text-white rounded-md text-sm font-medium transition-colors"
                  >
                      Delete Project
                  </button>
              ) : (
                  <div className={`flex items-center space-x-4 p-4 rounded-md ${ui.confirmBar}`}>
                      <span className={`text-sm font-medium ${ui.dangerHeading}`}>Are you absolutely sure?</span>
                      <button
                          onClick={handleDeleteProject}
                          disabled={isDeleting}
                          className="px-4 py-2 bg-[#C9372C] hover:bg-red-700 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors"
                      >
                          {isDeleting ? 'Deleting...' : 'Yes, Delete Project'}
                      </button>
                      <button
                          onClick={() => setShowDeleteConfirm(false)}
                          disabled={isDeleting}
                          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${ui.cancelBtn}`}
                      >
                          Cancel
                      </button>
                  </div>
              )}
           </div>
      </div>
    </div>
  );
}

export default ProjectSettings;