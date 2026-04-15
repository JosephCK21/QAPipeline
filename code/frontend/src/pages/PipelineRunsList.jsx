import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../App';
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
  const { refreshKey, showToast } = useAppContext();
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

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-5 h-5 text-[#50FA7B]" />;
      case 'failed':
      case 'error':
        return <XCircle className="w-5 h-5 text-[#FF5555]" />;
      case 'running':
      case 'in_progress':
      default:
        return <Loader className="w-5 h-5 text-[#8BE9FD] animate-spin" />;
    }
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'completed':
        return <span className="text-[#50FA7B] font-medium">Completed</span>;
      case 'failed':
      case 'error':
        return <span className="text-[#FF5555] font-medium">Failed</span>;
      case 'running':
      case 'in_progress':
      default:
        return <span className="text-[#8BE9FD] font-medium animate-pulse">Running</span>;
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header Section */}
      <div className="bg-[#1E1E2F] border border-[#282A36] p-4 rounded-xl flex items-center justify-between">
        <div className="flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-[#8BE9FD]" />
            <h1 className="text-xl font-bold text-white">Pipeline Runs</h1>
          </div>
          <p className="text-xs text-[#F8F8F2]/60 max-w-2xl">
            Live execution history of all QA pipelines triggered by GitHub events.
          </p>
        </div>
        
        <div className="bg-[#282A36] px-3 py-2 rounded-lg border border-[#6272A4]/30 flex flex-col items-center">
            <span className="text-xl font-bold text-[#F8F8F2]">{runs.length}</span>
            <span className="text-xs text-[#6272A4] uppercase tracking-wider font-semibold">Total Runs</span>
        </div>
      </div>

      {/* Table Section */}
      <div className="bg-[#1E1E2F] rounded-xl border border-[#282A36]">
        {loading ? (
            <div className="p-12 flex flex-col justify-center items-center text-[#6272A4]">
                <Loader className="w-8 h-8 animate-spin mb-4" />
                <p>Loading pipeline runs...</p>
            </div>
        ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#282A36] text-sm font-medium text-[#6272A4] bg-[#282A36]/30">
                    <th className="p-4 py-3">Run ID</th>
                    <th className="p-4 py-3">Status</th>
                    <th className="p-4 py-3">Trigger</th>
                    <th className="p-4 py-3">Time</th>
                    <th className="p-4 py-3">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#282A36]">
                  {runs.map(run => {
                    // find error in events
                    const errorEvent = run.events?.find(e => e.type === 'error');
                    const linkedProject = projects.find((project) => project.githubRepoFullName === run.repository?.full_name);
                    const eventError = errorEvent?.details || errorEvent?.data?.message;
                    const displayError = eventError || run.error;
                    
                    return (
                    <tr 
                      key={run.runId}
                      className="hover:bg-[#282A36]/50 transition-colors group cursor-pointer"
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
                            <PlayCircle className="w-5 h-5 text-[#6272A4]" />
                            <span className="font-mono text-[#F8F8F2] group-hover:text-[#8BE9FD] transition-colors">
                              {run.runId.substring(0, 8)}...
                            </span>
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(run.status)}
                          {getStatusText(run.status)}
                        </div>
                      </td>
                      <td className="p-4">
                        <span className="text-sm text-[#F8F8F2] bg-[#6272A4]/20 px-2 py-1 rounded">
                            {run.repository?.full_name || 'Manual'}
                        </span>
                      </td>
                      <td className="p-4 text-sm text-[#6272A4] flex items-center gap-1">
                        <Clock className="w-4 h-4" />
                        {new Date(run.createdAt || run.startedAt || Date.now()).toLocaleString()}
                      </td>
                      <td className="p-4 text-sm max-w-xs">
                          {displayError ? (
                              <div className="flex items-start gap-1 text-[#FF5555] bg-[#FF5555]/10 p-1.5 rounded">
                                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                  <span className="truncate">{displayError}</span>
                              </div>
                          ) : (
                              <span className="text-[#6272A4] italic">
                                  {run.events?.length || 0} events recorded
                              </span>
                          )}
                      </td>
                    </tr>
                  )})}
                  {runs.length === 0 && (
                      <tr>
                        <td colSpan="5" className="p-8 text-center text-[#6272A4]">
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