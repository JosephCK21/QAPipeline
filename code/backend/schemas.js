const { z } = require('zod');

/** Stored on `test_cases.schema_version` / `rtm_scenarios.schema_version` when generating or syncing. */
const CURRENT_SCHEMA_VERSION = 2;

const githubWebhookSchema = z.object({
    action: z.string().optional(),
    repository: z.object({
        full_name: z.string()
    }).passthrough().optional(),
    pull_request: z.object({
        html_url: z.string()
    }).passthrough().optional()
}).passthrough();

const jiraWebhookSchema = z.object({
    issue: z.object({
        key: z.string(),
        fields: z.object({
            issuetype: z.object({
                name: z.string()
            }).passthrough()
        }).passthrough()
    }).passthrough(),
    changelog: z.object({
        items: z.array(
            z.object({
                field: z.string(),
                toString: z.string().nullable().optional()
            }).passthrough()
        )
    }).passthrough().optional()
}).passthrough();

const projectCreateSchema = z.object({
    projectKey: z.string().optional(),
    name: z.string().optional(),
    repoFullName: z.string().optional(),
    jiraProjectKey: z.string().optional()
}).passthrough();

const SANDBOX_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const sandboxEnvPutSchema = z.object({
    env: z.record(z.string(), z.string())
}).superRefine((data, ctx) => {
    for (const key of Object.keys(data.env)) {
        if (!SANDBOX_ENV_KEY_REGEX.test(key)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Invalid env key "${key}": use ASCII letters, digits, underscore; first character must be letter or underscore.`,
                path: ['env', key]
            });
        }
        if (key.startsWith('AUTOQA_')) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'Keys prefixed with AUTOQA_ are reserved for the AutoQA harness and must not be set as project sandbox env (they would override Playwright/base URL and other behavior inside the container).',
                path: ['env', key]
            });
        }
    }
});

const validateBody = (schema) => (req, res, next) => {
    try {
        schema.parse(req.body);
        next();
    } catch (error) {
        console.error("Payload validation failed:", error.issues || error.message || error);
        return res.status(400).json({ error: "Validation failed", details: error.issues || error });
    }
};

module.exports = {
    CURRENT_SCHEMA_VERSION,
    githubWebhookSchema,
    jiraWebhookSchema,
    projectCreateSchema,
    sandboxEnvPutSchema,
    validateBody
};
