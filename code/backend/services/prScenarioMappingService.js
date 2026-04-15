const { Type } = require('@google/genai');
const { genAI } = require('./geminiService');

function safeParseJSON(text) {
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch (error) {
        const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            try {
                return JSON.parse(fenced[1]);
            } catch (innerError) {
                // Fall through to broad extraction.
            }
        }

        const first = String(text).indexOf('{');
        const last = String(text).lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
            return JSON.parse(String(text).slice(first, last + 1));
        }

        throw error;
    }
}

function responseSchema() {
    return {
        type: Type.OBJECT,
        properties: {
            mappings: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        scenarioId: { type: Type.STRING },
                        requirementId: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                        rationale: { type: Type.STRING },
                        impactedFiles: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING }
                        }
                    },
                    required: ['scenarioId', 'requirementId', 'confidence', 'rationale', 'impactedFiles']
                }
            },
            unresolvedChanges: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        filename: { type: Type.STRING },
                        reason: { type: Type.STRING }
                    },
                    required: ['filename', 'reason']
                }
            }
        },
        required: ['mappings', 'unresolvedChanges']
    };
}

function normalizeScenarioItem(item) {
    return {
        id: String(item?.id || '').trim(),
        description: String(item?.description || '').trim(),
        type: String(item?.type || '').trim(),
        relatedReq: String(item?.relatedReq || item?.parentReq || '').trim(),
        obsolete: Boolean(item?.obsolete)
    };
}

function normalizeResult(parsed, files, scenarios) {
    const scenarioById = new Map((scenarios || []).map((s) => [s.id, s]));

    const mappings = Array.isArray(parsed?.mappings)
        ? parsed.mappings
            .map((entry) => {
                const scenarioId = String(entry?.scenarioId || '').trim();
                if (!scenarioById.has(scenarioId)) return null;
                const confidenceRaw = Number(entry?.confidence);
                const confidence = Number.isFinite(confidenceRaw)
                    ? Math.max(0, Math.min(1, confidenceRaw))
                    : 0;
                return {
                    scenarioId,
                    requirementId: String(entry?.requirementId || scenarioById.get(scenarioId)?.relatedReq || '').trim(),
                    confidence,
                    rationale: String(entry?.rationale || '').trim(),
                    impactedFiles: Array.isArray(entry?.impactedFiles)
                        ? entry.impactedFiles.map((f) => String(f || '').trim()).filter(Boolean)
                        : []
                };
            })
            .filter(Boolean)
        : [];

    const unresolvedDefault = (files || []).map((file) => ({
        filename: String(file?.filename || '').trim(),
        reason: 'No confident scenario mapping returned by model'
    })).filter((item) => item.filename);

    const unresolvedChanges = Array.isArray(parsed?.unresolvedChanges)
        ? parsed.unresolvedChanges
            .map((entry) => ({
                filename: String(entry?.filename || '').trim(),
                reason: String(entry?.reason || 'Unresolved change').trim()
            }))
            .filter((entry) => entry.filename)
        : unresolvedDefault;

    return { mappings, unresolvedChanges };
}

async function mapPrChangesToScenarios({ prDetails, jiraRtmEntry, documentTexts = [] }) {
    const files = Array.isArray(prDetails?.files) ? prDetails.files : [];
    const scenarios = (Array.isArray(jiraRtmEntry?.scenarios) ? jiraRtmEntry.scenarios : [])
        .map(normalizeScenarioItem)
        .filter((scenario) => scenario.id && !scenario.obsolete);

    if (!files.length || !scenarios.length) {
        return {
            mappings: [],
            unresolvedChanges: files.map((file) => ({
                filename: String(file?.filename || '').trim(),
                reason: scenarios.length ? 'No file changes available' : 'No active scenarios available'
            })).filter((item) => item.filename)
        };
    }

    const model = process.env.GEMINI_MODEL || 'gemma-4-31b-it';

    const reducedFiles = files.map((file) => ({
        filename: file.filename,
        status: file.status,
        patch: String(file.patch || '').slice(0, 8000)
    }));

    const prompt = `You are an expert QA impact analyst.\n\nMap PR changes to the most relevant RTM scenarios.\n\nOutput strict JSON only.\n\nScenario catalog:\n${JSON.stringify(scenarios, null, 2)}\n\nPR context:\n${JSON.stringify({
        title: prDetails?.title || '',
        branch: prDetails?.branch || '',
        files: reducedFiles
    }, null, 2)}\n\nAdditional project context from uploaded documents:\n${JSON.stringify(documentTexts.slice(0, 5), null, 2)}\n\nRules:\n1) A PR file can map to multiple scenarios.\n2) Only map to scenarios that are actually relevant.\n3) Confidence must be between 0 and 1.\n4) Include unresolvedChanges for files where no reliable mapping exists.`;

    try {
        const response = await genAI.models.generateContent({
            model,
            contents: prompt,
            config: {
                responseSchema: responseSchema(),
                responseMimeType: 'application/json'
            }
        });

        const parsed = safeParseJSON(response.text);
        return normalizeResult(parsed, files, scenarios);
    } catch (error) {
        console.error('[prScenarioMappingService.mapPrChangesToScenarios] Failed:', error.message);
        return {
            mappings: [],
            unresolvedChanges: files.map((file) => ({
                filename: String(file?.filename || '').trim(),
                reason: `Mapping service fallback: ${error.message}`
            })).filter((item) => item.filename)
        };
    }
}

module.exports = {
    mapPrChangesToScenarios
};
