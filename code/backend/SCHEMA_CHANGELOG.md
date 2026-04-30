# AutoQA stored-artifact schema changelog

Version numbers match `CURRENT_SCHEMA_VERSION` in `schemas.js` and the `schema_version` columns on `test_cases` / `rtm_scenarios` (see `db.js` migrations).

| Version | Summary |
|--------:|---------|
| **1** | Initial tracked revision (default for legacy rows). |
| **2** | LLM trace persistence (`llm_trace_rows`), token rollups on `run_history`, `heal_exhausted` on `test_cases`, webhook idempotency (`webhook_deliveries`), scenario quality counters, `heal_patterns`, `reference_examples`, and DB-backed active-PR dedupe index. |
| **—** | Subsequent `migrateDbV2` additive column: **`test_cases.source`** — `'scenario'` (default / RTM-backed) or `'fallback'` for unmapped-file smoke tests (`scenarioId` sentinel **`FALLBACK`**). |
