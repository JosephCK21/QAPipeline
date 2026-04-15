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
    <div className="space-y-4 animate-fade-in">
      <div className="rounded-xl border border-[#282A36] bg-[#1E1E2F] p-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[#8BE9FD]">
            <FolderKanban className="h-4 w-4" />
            <span className="text-xs font-medium">Project-Centric Workspace</span>
          </div>
          <h1 className="text-xl font-bold text-[#F8F8F2]">Active Local Projects</h1>
          <p className="text-xs text-[#6272A4]">
            Create a local project, then link exactly one Jira space and one GitHub repository.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <form
          onSubmit={handleCreateProject}
          className="flex min-h-[250px] flex-col justify-between rounded-xl border border-dashed border-[#6272A4]/50 bg-[#1E1E2F] p-5 transition hover:border-[#8BE9FD] hover:bg-[#282A36]/30"
        >
          <div>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[#6272A4]/20 text-[#8BE9FD]">
              <Plus className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-[#F8F8F2]">Create Project</h2>
            <p className="mt-1 text-xs text-[#6272A4]">Start a new local workspace linked to Jira and GitHub.</p>
          </div>

          <div className="space-y-2">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Example: AutoQA Customer Portal"
              className="w-full rounded-lg border border-[#6272A4]/30 bg-[#282A36] px-3 py-2 text-sm text-[#F8F8F2] outline-none focus:border-[#8BE9FD]"
              disabled={creating}
            />
            <button
              type="submit"
              disabled={creating}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#6272A4] px-4 py-2 text-sm font-medium text-white hover:bg-[#7283b4] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creating ? <Loader className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {creating ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>

        {loading ? (
          <div className="flex min-h-[250px] flex-col items-center justify-center rounded-xl border border-[#282A36] bg-[#1E1E2F] text-[#6272A4]">
            <Loader className="mb-2 h-7 w-7 animate-spin" />
            Loading projects...
          </div>
        ) : (
          projects.map((project) => {
            const linkedCount = [project.jiraProjectKey, project.githubRepoFullName].filter(Boolean).length;
            const isComplete = linkedCount === 2;

            return (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="flex min-h-[250px] flex-col justify-between rounded-xl border border-[#282A36] bg-[#1E1E2F] p-5 transition hover:border-[#6272A4]/50"
              >
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-base font-semibold text-[#F8F8F2]">{project.name}</h3>
                    <span className={`rounded px-2 py-0.5 text-xs ${isComplete ? 'bg-green-600/20 text-green-300' : 'bg-amber-600/20 text-amber-300'}`}>
                      {isComplete ? 'Linked' : 'Pending Links'}
                    </span>
                  </div>
                  <p className="text-xs text-[#6272A4]">Project ID: {project.id.slice(0, 8)}...</p>
                </div>

                <div className="space-y-1 text-xs text-[#6272A4]">
                  <p className="flex items-center gap-2">
                    <GitBranch className="h-3.5 w-3.5" />
                    Jira: {project.jiraProjectKey || 'Not linked'}
                  </p>
                  <p className="flex items-center gap-2">
                    <Link2 className="h-3.5 w-3.5" />
                    GitHub: {project.githubRepoFullName || 'Not linked'}
                  </p>
                </div>
              </Link>
            );
          })
        )}
      </div>

      {!loading && projects.length === 0 && (
        <p className="text-sm text-[#6272A4]">No projects yet. Use the create card to add your first project.</p>
      )}
    </div>
  );
}

export default ProjectsHub;
