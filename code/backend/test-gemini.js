require('dotenv').config();
const { generateTestScenarios } = require('./services/geminiService');

(async () => {
    try {
        console.log("Testing generation...");
        let s = await generateTestScenarios({key: 'QPT-1', summary: 'Test', description: 'Test desc'}, {summary: 'Epic test'}, 'Docs');
        console.log("Success!", s);
    } catch(e) {
        console.error("Failed:", e);
    }
})();
