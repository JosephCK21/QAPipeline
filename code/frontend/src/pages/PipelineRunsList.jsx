import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../App';
import { deriveRunDisplayStatus } from '../lib/runDisplayStatus';
import { 
  Activity, 
  PlayCircle, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Loader,
  AlertTriangle
} from 'lucide-react';

function PipelineRunsList() {
  const { refreshKey, showToast, darkMode } = useAppContext();
  const navigate = useNavigate();
  const [runs, setRuns] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRuns = async () => {
      try {
        const [runsRes, projectsRes] = await Promise.all([
          fetch('http://localhost:3001/api/runs'),
          fetch('http://localhost:3001/api/projects')
        ]);
        if (!runsRes.ok) throw new Error('Failed to fetch pipeline runs');
        if (!projectsRes.ok) throw new Error('Failed to fetch projects');

        const data = await runsRes.json();
        const projectData = await projectsRes.json();

        // Sort runs by time descending
        const sortedData = data.sort((a, b) => new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0));
        setRuns(sortedData);
        setProjects(Array.isArray(projectData) ? projectData : []);
      } catch (error) {
        console.error(error);
        showToast('Error loading pipeline runs', 'error');
      } finally {
        setLoading(false);
      }
    };
    fetchRuns();
  }, [refreshKey]);

  const getRunStatusIcon = (run) => {
    const d = deriveRunDisplayStatus(run);
    switch (d.variant) {
      case 'green':
        return <CheckCircle2 className={`w-5 h-5 shrink-0 ${darkMode ? 'text-[#3FB950]' : 'text-[#00875A]'}`} />;
      case 'red':
        return <XCircle className={`w-5 h-5 shrink-0 ${darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'}`} />;
      case 'amber':
        return <AlertTriangle className={`w-5 h-5 shrink-0 ${darkMode ? 'text-[#D29922]' : 'text-[#B65C00]'}`} />;
      case 'neutral':
        return <CheckCircle2 className={`w-5 h-5 shrink-0 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`} />;
      case 'blue':
      default:
        return <Loader className={`w-5 h-5 shrink-0 animate-spin ${darkMode ? 'text-[#58A6FF]' : 'text-[#0C66E4]'}`} />;
    }
  };

  const getRunStatusText = (run) => {
    const d = deriveRunDisplayStatus(run);
    const cls =
      d.variant === 'green' ? (darkMode ? 'text-[#3FB950]' : 'text-[#00875A]') :
      d.variant === 'red' ? (darkMode ? 'text-[#F85149]' : 'text-[#C9372C]') :
      d.variant === 'amber' ? (darkMode ? 'text-[#D29922]' : 'text-[#B65C00]') :
      d.variant === 'neutral' ? (darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]') :
      (darkMode ? 'text-[#58A6FF] animate-pulse' : 'text-[#0C66E4] animate-pulse');
    return <span className={`${cls} font-medium`}>{d.label}</span>;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header Section */}
      <div className={`p-4 rounded-xl flex items-center justify-between border ${
        darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#FFFFFF] border-[#DFE1E6]'
      }`}>
        <div className="flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <Activity className={`w-4 h-4 ${darkMode ? 'text-[#58A6FF]' : 'text-[#0C66E4]'}`} />
            <h1 className={`text-xl font-bold ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>Pipeline Runs</h1>
          </div>
          <p className={`text-xs max-w-2xl ${darkMode ? 'text-[#8B949E]' : 'text-[#172B4D]/60'}`}>
            Live execution history of all QA pipelines triggered by GitHub events.
          </p>
        </div>
        
        <div className={`px-3 py-2 rounded-lg border flex flex-col items-center ${
          darkMode ? 'bg-[#21262D] border-[#484F58]' : 'bg-[#DFE1E6] border-[#5E6C84]/30'
        }`}>
            <span className={`text-xl font-bold ${darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'}`}>{runs.length}</span>
            <span className={`text-xs uppercase tracking-wider font-semibold ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>Total Runs</span>
        </div>
      </div>

      {/* Table Section */}
      <div className={`rounded-xl border ${darkMode ? 'bg-[#161B22] border-[#30363D]' : 'bg-[#FFFFFF] border-[#DFE1E6]'}`}>
        {loading ? (
            <div className={`p-12 flex flex-col justify-center items-center ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                <Loader className={`w-8 h-8 animate-spin mb-4 ${darkMode ? 'text-[#58A6FF]' : 'text-[#0C66E4]'}`} />
                <p>Loading pipeline runs...</p>
            </div>
        ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className={`text-sm font-medium border-b ${
                    darkMode
                      ? 'border-[#30363D] text-[#8B949E] bg-[#21262D]'
                      : 'border-[#DFE1E6] text-[#5E6C84] bg-[#DFE1E6]/30'
                  }`}>
                    <th className="p-4 py-3">Run ID</th>
                    <th className="p-4 py-3">Status</th>
                    <th className="p-4 py-3">Trigger</th>
                    <th className="p-4 py-3">Time</th>
                    <th className="p-4 py-3">Details</th>
                  </tr>
                </thead>
                <tbody className={darkMode ? 'divide-y divide-[#30363D]' : 'divide-y divide-[#DFE1E6]'}>
                  {runs.map(run => {
                    // find error in events
                    const errorEvent = run.events?.find(e => e.type === 'error');
                    const linkedProject = projects.find((project) => project.githubRepoFullName === run.repository?.full_name);
                    const eventError = errorEvent?.details || errorEvent?.data?.message;
                    const displayError = eventError || run.error;
                    
                    return (
                    <tr 
                      key={run.runId}
                      className={`transition-colors group cursor-pointer ${
                        darkMode ? 'hover:bg-[#21262D]' : 'hover:bg-[#DFE1E6]/50'
                      }`}
                      onClick={() => {
                        if (linkedProject?.id) {
                          navigate(`/projects/${linkedProject.id}?workspace=github-runs&runId=${run.runId}`);
                          return;
                        }

                        if (run.localProjectId) {
                          navigate(`/projects/${run.localProjectId}?workspace=github-runs&runId=${run.runId}`);
                          return;
                        }

                        showToast('No linked project found for this run.', 'error');
                      }}
                    >
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                            <PlayCircle className={`w-5 h-5 shrink-0 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`} />
                            <span className={`font-mono transition-colors ${
                              darkMode ? 'text-[#E6EDF3] group-hover:text-[#58A6FF]' : 'text-[#172B4D] group-hover:text-[#0C66E4]'
                            }`}>
                              {run.runId.substring(0, 8)}...
                            </span>
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {getRunStatusIcon(run)}
                          {getRunStatusText(run)}
                        </div>
                      </td>
                      <td className="p-4">
                        <span className={`text-sm px-2 py-1 rounded ${
                          darkMode
                            ? 'text-[#E6EDF3] bg-[#30363D] border border-[#484F58]'
                            : 'text-[#172B4D] bg-[#5E6C84]/20'
                        }`}>
                            {run.repository?.full_name || 'Manual'}
                        </span>
                      </td>
                      <td className={`p-4 text-sm flex items-center gap-1 ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                        <Clock className="w-4 h-4" />
                        {new Date(run.createdAt || run.startedAt || Date.now()).toLocaleString()}
                      </td>
                      <td className="p-4 text-sm max-w-xs">
                          <div className="space-y-1">
                          {(Number(run.input_tokens_total) > 0 || Number(run.output_tokens_total) > 0) && (
                            <div className={`text-[10px] rounded px-1.5 py-0.5 ${
                              darkMode
                                ? 'text-[#58A6FF] bg-[rgba(56,139,253,0.12)] border border-[rgba(56,139,253,0.35)]'
                                : 'text-[#172B4D] bg-[#DEEBFF]/40 border border-[#B3D4FF]/50'
                            }`} title="Rolled up from persisted LLM usage">
                              Tokens in {run.input_tokens_total ?? 0} · out {run.output_tokens_total ?? 0}
                              {Number(run.cached_tokens_total) > 0 ? ` · cached ${run.cached_tokens_total}` : ''}
                            </div>
                          )}
                          {displayError ? (
                              <div className={`flex items-start gap-1 p-1.5 rounded ${
                                darkMode ? 'text-[#F85149] bg-[rgba(248,81,73,0.12)]' : 'text-[#C9372C] bg-[#C9372C]/10'
                              }`}>
                                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                  <span className="truncate">{displayError}</span>
                              </div>
                          ) : (
                              <span className={`italic ${darkMode ? 'text-[#6E7681]' : 'text-[#5E6C84]'}`}>
                                  {run.events?.length || 0} events recorded
                              </span>
                          )}
                          </div>
                      </td>
                    </tr>
                  )})}
                  {runs.length === 0 && (
                      <tr>
                        <td colSpan="5" className={`p-8 text-center ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                            No pipeline runs found.
                        </td>
                      </tr>
                  )}
                </tbody>
              </table>
            </div>
        )}
      </div>
    </div>
  );
}

export default PipelineRunsList;