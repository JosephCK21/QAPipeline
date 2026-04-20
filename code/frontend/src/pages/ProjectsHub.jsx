import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FolderKanban, Plus, Loader, Link2, GitBranch } from 'lucide-react';
import { useAppContext } from '../App';

function ProjectsHub() {
  const navigate = useNavigate();
  const { refreshKey, showToast } = useAppContext();

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  const loadProjects = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3001/api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      setProjects(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error(error);
      showToast(`Could not load projects: ${error.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, [refreshKey]);

  const handleCreateProject = async (event) => {
    event.preventDefault();
    const trimmedName = newProjectName.trim();
    if (!trimmedName) {
      showToast('Project name is required', 'error');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('http://localhost:3001/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName })
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Failed to create project');

      setNewProjectName('');
      showToast('Project created', 'success');
      navigate(`/projects/${payload.id}`);
    } catch (error) {
      console.error(error);
      showToast(`Create failed: ${error.message}`, 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page header — clean, Jira-style */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[#5E6C84]">
            <FolderKanban className="h-4 w-4" />
            <span className="text-[11px] font-medium uppercase tracking-wider">Projects</span>
          </div>
          <h1 className="text-2xl font-semibold text-[#172B4D] tracking-tight">Active local projects</h1>
          <p className="text-sm text-[#5E6C84] max-w-xl">
            Create a local project, then link exactly one Jira space and one GitHub repository.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {/* Create-project card */}
        <form
          onSubmit={handleCreateProject}
          className="flex min-h-[250px] flex-col justify-between rounded-lg border-2 border-dashed border-[#DFE1E6] bg-white p-5 transition-colors hover:border-[#0C66E4] hover:bg-[#F7FAFF]"
        >
          <div>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-[#E9F2FF] text-[#0C66E4]">
              <Plus className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-[#172B4D]">Create project</h2>
            <p className="mt-1 text-xs text-[#5E6C84]">Start a new local workspace linked to Jira and GitHub.</p>
          </div>

          <div className="space-y-2">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Example: AutoQA Customer Portal"
              className="w-full rounded-md border border-[#DFE1E6] bg-[#FAFBFC] px-3 py-2 text-sm text-[#172B4D] placeholder-[#8993A4] outline-none transition focus:border-[#0C66E4] focus:bg-white focus:ring-1 focus:ring-[#0C66E4]"
              disabled={creating}
            />
            <button
              type="submit"
              disabled={creating}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#0C66E4] px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#0747A6] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creating ? <Loader className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {creating ? 'Creating...' : 'Create project'}
            </button>
          </div>
        </form>

        {loading ? (
          <div className="flex min-h-[250px] flex-col items-center justify-center rounded-lg border border-[#DFE1E6] bg-white text-[#5E6C84]">
            <Loader className="mb-2 h-7 w-7 animate-spin" />
            <span className="text-sm">Loading projects...</span>
          </div>
        ) : (
          projects.map((project) => {
            const linkedCount = [project.jiraProjectKey, project.githubRepoFullName].filter(Boolean).length;
            const isComplete = linkedCount === 2;

            return (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="group flex min-h-[250px] flex-col justify-between rounded-lg border border-[#DFE1E6] bg-white p-5 shadow-[0_1px_2px_rgba(9,30,66,0.08)] transition-all hover:-translate-y-0.5 hover:border-[#0C66E4]/60 hover:shadow-[0_4px_12px_-2px_rgba(9,30,66,0.12)]"
              >
                <div>
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <h3 className="text-base font-semibold text-[#172B4D] group-hover:text-[#0747A6] transition-colors line-clamp-2">
                      {project.name}
                    </h3>
                    <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${
                      isComplete
                        ? 'bg-[#E3FCEF] text-[#006644]'
                        : 'bg-[#FFF7D6] text-[#974F0C]'
                    }`}>
                      {isComplete ? 'Linked' : 'Pending links'}
                    </span>
                  </div>
                  <p className="text-xs text-[#8993A4] font-mono">ID: {project.id.slice(0, 8)}</p>
                </div>

                <div className="space-y-1.5 text-xs text-[#5E6C84] pt-3 border-t border-[#F1F2F4]">
                  <p className="flex items-center gap-2 truncate">
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#8993A4]" />
                    <span className="font-medium text-[#172B4D]">Jira:</span>
                    <span className="truncate">{project.jiraProjectKey || <span className="text-[#8993A4]">Not linked</span>}</span>
                  </p>
                  <p className="flex items-center gap-2 truncate">
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-[#8993A4]" />
                    <span className="font-medium text-[#172B4D]">GitHub:</span>
                    <span className="truncate">{project.githubRepoFullName || <span className="text-[#8993A4]">Not linked</span>}</span>
                  </p>
                </div>
              </Link>
            );
          })
        )}
      </div>

      {!loading && projects.length === 0 && (
        <p className="text-sm text-[#5E6C84]">No projects yet. Use the create card to add your first project.</p>
      )}
    </div>
  );
}

export default ProjectsHub;
