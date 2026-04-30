# Dev scripts

Hand-run helpers; run from repo root with `node code/devscripts/<file>.js` or via `npm run jira:*` from `code/backend`.

| Script | Purpose |
|--------|---------|
| `start.js` | Spawn backend + frontend dev processes. |
| `clear.js` | Wipe DB, JSON stores, uploads, artifacts, sandbox temp dirs. |
| `installbeforerun.js` | Install backend/frontend deps. |
| `checkJiraApi.js` | Print Jira issue metadata for one key. |
| `simulateJiraWebhook.js` | POST sample Jira webhook to local backend. |
| `deleteJiraStoryComments.js` | Remove AutoQA-tagged comments (dry-run unless `--apply`). |
| `clearPipelineTestData.js` | Clear pipeline execution data via `clearAllPipelineExecutionData`. |
| `seedTodoJiraIssues.js` / `deleteTodoJiraIssues.js` | Seed or delete Todo FRD issues. |
| `seedSayaratJiraIssues.js` / `deleteSayaratJiraIssues.js` | Sayarat seed/delete; seed file may be gitignored locally. |
