/**
 * Normalize a test-case status string into one of three canonical buckets:
 *   'pass' | 'fail' | 'notDone'
 *
 * "Done" means the test case has been executed and a verdict reached.
 * Any unknown / missing / pending / running value is treated as not done.
 */
export function normalizeTestCaseStatus(status) {
  const s = (status || '').toLowerCase().trim();
  if (s === 'pass' || s === 'completed') return 'pass';
  if (s === 'fail') return 'fail';
  return 'notDone';
}

/**
 * Determine the strict pass status for a single scenario.
 *
 * Strict pass: scenario has at least one test case AND every test case is pass.
 * Fail: at least one test case is fail (regardless of others).
 * Pending: no test cases, or all test cases are not-done (pending/running).
 *
 * @returns {'pass' | 'fail' | 'pending'}
 */
export function scenarioStrictStatus(scenario) {
  const tcs = scenario.testCases || [];
  if (tcs.length === 0) return 'pending';

  const statuses = tcs.map((tc) => normalizeTestCaseStatus(tc.status));
  if (statuses.every((s) => s === 'pass')) return 'pass';
  if (statuses.some((s) => s === 'fail')) return 'fail';
  return 'pending';
}

/**
 * Compute test-case AND scenario-level split totals for a single epic.
 *
 * Test-case metrics (backward-compatible):
 *   total, done, notDone, passed, failed, donePct, notDonePct
 *
 * Scenario metrics (new):
 *   totalScenarios, passedScenariosStrict, failedScenarios, pendingScenarios, scenarioPassPct
 *
 * @param {string}   epicKey      - The epic key (used for labeling only)
 * @param {Array}    reqs         - Requirement objects belonging to this epic
 * @param {Array}    allScenarios - All scenarios in the RTM dataset
 */
export function computeEpicMetrics(epicKey, reqs, allScenarios) {
  // Test-case counters
  let total = 0;
  let passed = 0;
  let failed = 0;

  // Scenario counters
  let totalScenarios = 0;
  let passedScenariosStrict = 0;
  let failedScenarios = 0;
  let pendingScenarios = 0;

  const reqIds = new Set((reqs || []).map((r) => r.reqId));

  (allScenarios || []).forEach((scenario) => {
    // Support both parentReq (dashboard data shape) and relatedReq (RTMMatrix shape)
    const linkedReq = scenario.parentReq || scenario.relatedReq;
    if (!reqIds.has(linkedReq)) return;

    // Scenario-level
    totalScenarios += 1;
    const strictStatus = scenarioStrictStatus(scenario);
    if (strictStatus === 'pass') passedScenariosStrict += 1;
    else if (strictStatus === 'fail') failedScenarios += 1;
    else pendingScenarios += 1;

    // Test-case-level
    (scenario.testCases || []).forEach((tc) => {
      total += 1;
      const norm = normalizeTestCaseStatus(tc.status);
      if (norm === 'pass') passed += 1;
      else if (norm === 'fail') failed += 1;
    });
  });

  const done = passed + failed;
  const notDone = total - done;

  return {
    epicKey,
    // test-case totals (existing)
    total,
    done,
    notDone,
    passed,
    failed,
    donePct: total > 0 ? Math.round((done / total) * 100) : 0,
    notDonePct: total > 0 ? Math.round((notDone / total) * 100) : 0,
    // scenario totals (new)
    totalScenarios,
    passedScenariosStrict,
    failedScenarios,
    pendingScenarios,
    scenarioPassPct: totalScenarios > 0
      ? Math.round((passedScenariosStrict / totalScenarios) * 100)
      : 0,
  };
}

/**
 * Build a map of epicKey → metrics for every epic in `groupedRequirements`.
 *
 * @param {Object.<string, Array>} groupedRequirements - epicKey → req[]
 * @param {Array}                  allScenarios
 * @returns {Object.<string, ReturnType<computeEpicMetrics>>}
 */
export function computeAllEpicMetrics(groupedRequirements, allScenarios) {
  const result = {};
  Object.entries(groupedRequirements || {}).forEach(([epicKey, reqs]) => {
    result[epicKey] = computeEpicMetrics(epicKey, reqs, allScenarios);
  });
  return result;
}
