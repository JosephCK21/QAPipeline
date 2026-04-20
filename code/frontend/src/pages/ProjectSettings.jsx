import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Activity, GitCommit, Settings as SettingsIcon, ArrowLeft, AlertTriangle } from 'lucide-react';
import { useAppContext } from '../App';
import BranchPolicyMatrix from '../components/BranchPolicyMatrix';

function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { showToast, refreshKey } = useAppContext();
  
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

  useEffect(() => {
    fetchProjectData();
    fetchIntegrations();
  }, [projectId, refreshKey]);

  const fetchProjectData = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${projectId}`);
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
        fetch('http://localhost:3001/api/jira/spaces'),
        fetch('http://localhost:3001/api/github/repos')
      ]);
      if (jiraRes.ok) setSpaces(await jiraRes.json());
      if (githubRes.ok) setRepos(await githubRes.json());
    } catch (error) {
      console.error('Failed to load integrations lists', error);
    }
  };

  const handleLinkJira = async () => {
      try {
          setIsLinkingJira(true);
          const space = spaces.find(s => s.key === selectedJiraSpace);
          const res = await fetch(`http://localhost:3001/api/projects/${projectId}/jira-link`, {
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
          const res = await fetch(`http://localhost:3001/api/projects/${projectId}/github-link`, {
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
          const res = await fetch(`http://localhost:3001/api/projects/${projectId}`, {
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

  if (loading) {
    return <div className="p-8 text-[#5E6C84]">Loading project settings...</div>;
  }

  return (
    <div className="space-y-6 relative overflow-hidden h-full">
      {/* Header Info */}
      <div className="flex justify-between items-start bg-[#F4F5F7] border border-[#DFE1E6] p-6 rounded-lg">
        <div>
          <button 
            onClick={() => navigate(`/projects/${projectId}`)}
            className="flex items-center text-sm text-indigo-400 hover:text-indigo-300 mb-4 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400 mb-2 flex items-center">
            <SettingsIcon className="w-6 h-6 mr-2 text-indigo-400" />
            Project Settings
          </h1>
          <div className="flex space-x-4 text-sm text-[#5E6C84]">
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
           <div className="bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg p-6">
               <h3 className="text-lg font-medium text-[#172B4D] mb-4">Integrations</h3>
               <div className="space-y-6">
                   <div className="flex flex-col md:flex-row md:items-center space-y-4 md:space-y-0 md:space-x-4">
                       <div className="w-full md:w-1/3">
                           <label className="block text-sm font-medium text-[#5E6C84] mb-1">Jira Space</label>
                           <select
                               className="w-full bg-[#F1F2F4] border border-[#C1C7D0] text-[#5E6C84] rounded-md py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500"
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
                           <label className="block text-sm font-medium text-[#5E6C84] mb-1">GitHub Repository</label>
                           <select
                               className="w-full bg-[#F1F2F4] border border-[#C1C7D0] text-[#5E6C84] rounded-md py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500"
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

           <div className="bg-[#F4F5F7] border border-[#DFE1E6] rounded-lg p-6">
              <h3 className="text-lg font-medium text-[#172B4D] mb-4">Pipeline Execution Behaviors</h3>
              <BranchPolicyMatrix />
           </div>

           {/* Danger Zone */}
           <div className="bg-[#FFEBE6] border border-[#FFBDAD] rounded-lg p-6 mt-10">
              <h3 className="text-lg font-medium text-red-500 mb-2 flex items-center">
                  <AlertTriangle className="w-5 h-5 mr-2" />
                  Danger Zone
              </h3>
              <p className="text-sm text-[#5E6C84] mb-6">
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
                  <div className="flex items-center space-x-4 bg-black/30 p-4 rounded-md border border-[#FFBDAD]">
                      <span className="text-sm font-medium text-[#C9372C]">Are you absolutely sure?</span>
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
                          className="px-4 py-2 bg-[#F1F2F4] hover:bg-[#DFE1E6] text-[#5E6C84] rounded-md text-sm font-medium transition-colors"
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