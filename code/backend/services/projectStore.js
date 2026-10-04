const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { deleteSandboxEnv } = require('./sandboxEnvStore');
const { deleteDefaultTestAccounts } = require('./defaultTestAccountsStore');

const projectsStorePath = path.join(__dirname, '..', 'data', 'projects.json');

function readProjectsStore() {
    if (!fs.existsSync(projectsStorePath)) return { projects: [] };
    try {
        const content = fs.readFileSync(projectsStorePath, 'utf8');
        const cleaned = (content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content)
            .replace(/\0/g, '')
            .trim() || '{"projects": []}';
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed.projects)) return { projects: [] };
        return parsed;
    } catch (error) {
        console.error('[projectStore.readProjectsStore] Failed to parse projects.json:', error.message);
        return { projects: [] };
    }
}

function writeProjectsStore(store) {
    fs.writeFileSync(projectsStorePath, JSON.stringify(store, null, 2), 'utf8');
}

function listProjects() {
    const store = readProjectsStore();
    return store.projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getProjectById(projectId) {
    const store = readProjectsStore();
    return store.projects.find((project) => project.id === projectId) || null;
}

function createProject(name) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
        throw new Error('Project name is required');
    }

    const store = readProjectsStore();
    const duplicate = store.projects.find((project) => project.name.toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) {
        throw new Error('Project name already exists');
    }

    const now = new Date().toISOString();
    const newProject = {
        id: uuidv4(),
        name: trimmedName,
        createdAt: now,
        updatedAt: now,
        jiraProjectKey: null,
        jiraProjectName: null,
        githubRepoFullName: null
    };

    store.projects.push(newProject);
    writeProjectsStore(store);
    return newProject;
}

function linkJiraSpace(projectId, jiraProjectKey, jiraProjectName) {
    const key = String(jiraProjectKey || '').trim();
    if (!key) throw new Error('jiraProjectKey is required');

    const store = readProjectsStore();
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) throw new Error('Project not found');

    const conflict = store.projects.find((p) => p.id !== projectId && p.jiraProjectKey === key);
    if (conflict) {
        throw new Error(`Jira space ${key} is already linked to project \"${conflict.name}\"`);
    }

    project.jiraProjectKey = key;
    project.jiraProjectName = String(jiraProjectName || '').trim() || key;
    project.updatedAt = new Date().toISOString();
    writeProjectsStore(store);

    return project;
}

function linkGithubRepo(projectId, githubRepoFullName) {
    const repo = String(githubRepoFullName || '').trim();
    if (!repo) throw new Error('githubRepoFullName is required');

    const store = readProjectsStore();
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) throw new Error('Project not found');

    const conflict = store.projects.find((p) => p.id !== projectId && p.githubRepoFullName === repo);
    if (conflict) {
        throw new Error(`GitHub repo ${repo} is already linked to project \"${conflict.name}\"`);
    }

    project.githubRepoFullName = repo;
    project.updatedAt = new Date().toISOString();
    writeProjectsStore(store);

    return project;
}

function findProjectByGithubRepo(repoFullName) {
    const repo = String(repoFullName || '').trim();
    if (!repo) return null;
    const store = readProjectsStore();
    return store.projects.find((p) => p.githubRepoFullName === repo) || null;
}

function findProjectByJiraProjectKey(projectKey) {
    const key = String(projectKey || '').trim();
    if (!key) return null;
    const store = readProjectsStore();
    return store.projects.find((p) => p.jiraProjectKey === key) || null;
}

function deleteProject(projectId) {
    const store = readProjectsStore();
    const index = store.projects.findIndex((p) => p.id === projectId);
    if (index === -1) return null;
    
    const deletedProject = store.projects[index];
    store.projects.splice(index, 1);
    writeProjectsStore(store);

    deleteSandboxEnv(projectId);
    deleteDefaultTestAccounts(projectId);

    return deletedProject;
}

module.exports = {
    deleteProject,
    listProjects,
    getProjectById,
    createProject,
    linkJiraSpace,
    linkGithubRepo,
    findProjectByGithubRepo,
    findProjectByJiraProjectKey
};
