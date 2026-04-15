const fs = require('fs').promises;
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

function isDocx(filePath, mimeType) {
    return (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        String(filePath || '').toLowerCase().endsWith('.docx')
    );
}

async function extractTextFromFile(filePath, mimeType) {
    try {
        if (!filePath) return '';

        if (mimeType === 'application/pdf') {
            const dataBuffer = await fs.readFile(filePath);
            const parsed = await pdf(dataBuffer);
            return String(parsed?.text || '').trim();
        }

        if (isDocx(filePath, mimeType)) {
            const result = await mammoth.extractRawText({ path: filePath });
            return String(result?.value || '').trim();
        }

        const rawText = await fs.readFile(filePath, 'utf8');
        return String(rawText || '').trim();
    } catch (error) {
        const fileName = filePath ? path.basename(filePath) : 'unknown-file';
        console.warn(`[documentParserService.extractTextFromFile] Failed for ${fileName}: ${error.message}`);
        return '';
    }
}

async function extractTextFromFiles(fileMetadataArray) {
    try {
        const files = Array.isArray(fileMetadataArray) ? fileMetadataArray : [];

        return await Promise.all(
            files.map((fileMeta) => {
                const filePath = fileMeta?.path || '';
                const mimeType = fileMeta?.mimeType || fileMeta?.mimetype || '';
                return extractTextFromFile(filePath, mimeType);
            })
        );
    } catch (error) {
        console.warn(`[documentParserService.extractTextFromFiles] Failed: ${error.message}`);
        return [];
    }
}

module.exports = {
    extractTextFromFile,
    extractTextFromFiles
};
