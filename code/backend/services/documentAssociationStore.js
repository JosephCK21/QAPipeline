const fs = require('fs');
const path = require('path');

const jiraDocumentsPath = path.join(__dirname, '..', 'data', 'jiraDocuments.json');

function getDocumentStore() {
    if (!fs.existsSync(jiraDocumentsPath)) return {};
    try {
        const content = fs.readFileSync(jiraDocumentsPath, 'utf8');
        const cleaned = (content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content)
            .replace(/\0/g, '')
            .trim() || '{}';
        return JSON.parse(cleaned);
    } catch (error) {
        console.error('[documentAssociationStore.getDocumentStore] Failed to parse jiraDocuments.json:', error.message);
        return {};
    }
}

function saveDocumentStore(store) {
    fs.writeFileSync(jiraDocumentsPath, JSON.stringify(store, null, 2), 'utf8');
}

function getDocsForProject(projectId) {
    const key = String(projectId || '').trim();
    if (!key) return [];

    const store = getDocumentStore();
    return Array.isArray(store[key]) ? store[key] : [];
}

function addDocToProject(projectId, fileMetadata) {
    const key = String(projectId || '').trim();
    if (!key) throw new Error('projectId is required');

    const store = getDocumentStore();
    if (!Array.isArray(store[key])) store[key] = [];

    store[key].push({
        path: fileMetadata.path,
        mimeType: fileMetadata.mimeType || fileMetadata.mimetype || '',
        originalName: fileMetadata.originalName || fileMetadata.originalname || '',
        uploadedAt: fileMetadata.uploadedAt || new Date().toISOString()
    });

    saveDocumentStore(store);
    return store[key];
}

function removeDocFromProject(projectId, filePath) {
    const key = String(projectId || '').trim();
    const targetPath = String(filePath || '').trim();
    if (!key || !targetPath) return [];

    const store = getDocumentStore();
    if (!Array.isArray(store[key])) return [];

    store[key] = store[key].filter((doc) => doc.path !== targetPath);

    try {
        if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
        }
    } catch (error) {
        console.warn(`[documentAssociationStore.removeDocFromProject] Failed to delete file ${targetPath}: ${error.message}`);
    }

    saveDocumentStore(store);
    return store[key];
}

function deleteAllDocsForProject(projectId) {
    const key = String(projectId || '').trim();
    if (!key) return;

    const store = getDocumentStore();
    if (!Array.isArray(store[key])) return;

    const docs = store[key];
    docs.forEach(doc => {
        try {
            if (fs.existsSync(doc.path)) {
                fs.unlinkSync(doc.path);
            }
        } catch (error) {
            console.warn(`[documentAssociationStore.deleteAllDocsForProject] Failed to delete file ${doc.path}: ${error.message}`);
        }
    });

    delete store[key];
    saveDocumentStore(store);
}

module.exports = {
    deleteAllDocsForProject,
    getDocsForProject,
    addDocToProject,
    removeDocFromProject
};
