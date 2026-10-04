/**
 * Derives pipeline run list UI status from run_history row + optional DB counters.
 */

export function getRunOutcomeCounts(run) {
  let passed = run.finished_passed_count;
  let failed = run.finished_failed_count;
  let total = run.finished_test_case_count;

  const hasDb =
    passed != null ||
    failed != null ||
    total != null;

  if (!hasDb) {
    const summaryEvent = [...(run.events || [])]
      .reverse()
      .find((e) => e.type === 'run_summary_updated');
    const s = summaryEvent?.data || {};
    if (typeof s.passedCount === 'number') passed = s.passedCount;
    if (typeof s.failedCount === 'number') failed = s.failedCount;
    if (typeof s.testCaseCount === 'number') total = s.testCaseCount;
  }

  passed = Number(passed) || 0;
  failed = Number(failed) || 0;
  let totalNum = total == null || Number.isNaN(Number(total)) ? passed + failed : Number(total);

  return { passed, failed, total: totalNum };
}

/** Human-readable duration for run history row (no deps). */
function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const rSec = sec % 60;
  if (m < 60) return rSec ? `${m}m ${rSec}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rMin = m % 60;
  return `${h}h ${rMin}m`;
}

/**
 * Compact subtitle for Execution History rows (repo, PR, counts, duration, retries).
 * Uses DB-backed counts via getRunOutcomeCounts; retries/scenarios only when latest
 * persisted event is run_summary_updated (single-slot events array).
 * @returns {{ line: string }}
 */
export function buildRunHistoryDetailLine(run) {
  const parts = [];
  const repo = String(run.repoFullName || '').trim();
  if (repo) parts.push(repo);

  const prUrl = String(run.prUrl || '');
  const prMatch = prUrl.match(/\/pull\/(\d+)/i);
  if (prMatch) parts.push(`PR #${prMatch[1]}`);

  let summaryData = {};
  if (Array.isArray(run.events) && run.events[0]?.type === 'run_summary_updated') {
    summaryData = run.events[0].data || {};
  }
  const scenarioCount = Number(summaryData.scenarioCount);
  if (scenarioCount > 0) {
    parts.push(`${scenarioCount} scenario${scenarioCount !== 1 ? 's' : ''}`);
  }

  const { passed, failed, total } = getRunOutcomeCounts(run);
  if (total > 0) {
    parts.push(`${total} case${total !== 1 ? 's' : ''} · ${passed} pass · ${failed} fail`);
  }

  const started = run.createdAt ? new Date(run.createdAt).getTime() : NaN;
  const ended = run.completedAt ? new Date(run.completedAt).getTime() : NaN;
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    const dur = formatDurationMs(ended - started);
    if (dur) parts.push(dur);
  }

  const retries = Number(summaryData.retryCount) || 0;
  if (retries > 0) {
    parts.push(`${retries} retr${retries === 1 ? 'y' : 'ies'}`);
  }

  return { line: parts.filter(Boolean).join(' · ') };
}

/**
 * @returns {{ kind: string, label: string, variant: 'blue'|'green'|'amber'|'red'|'neutral' }}
 */
export function deriveRunDisplayStatus(run) {
  const status = String(run.status || '').toLowerCase();

  if (status === 'running') {
    return { kind: 'running', label: 'Running', variant: 'blue' };
  }

  const terminal = status === 'completed' || status === 'failed' || status === 'error';
  if (!terminal) {
    return { kind: 'running', label: 'Running', variant: 'blue' };
  }

  const { passed, failed } = getRunOutcomeCounts(run);

  if (passed > 0 && failed === 0) {
    return { kind: 'passed', label: 'Passed', variant: 'green' };
  }
  if (passed > 0 && failed > 0) {
    return { kind: 'partial', label: 'Partial pass', variant: 'amber' };
  }
  if (passed === 0 && failed > 0) {
    return { kind: 'all_failed', label: 'Failed', variant: 'red' };
  }

  const overallOk =
    run.overall_success === 1 ||
    run.overall_success === true ||
    String(run.overall_success) === '1';
  const overallBad = run.overall_success === 0 || run.overall_success === false || String(run.overall_success) === '0';

  if (passed === 0 && failed === 0) {
    if (status === 'failed' || status === 'error') {
      return { kind: 'all_failed', label: 'Failed', variant: 'red' };
    }
    if (overallBad) {
      return { kind: 'no_tests_failed', label: 'Failed', variant: 'red' };
    }
    if (overallOk || status === 'completed') {
      return { kind: 'passed_empty', label: 'Passed', variant: 'green' };
    }
    return { kind: 'unknown_done', label: 'Done', variant: 'neutral' };
  }
}
