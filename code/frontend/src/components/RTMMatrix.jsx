import React, { useMemo, useState } from 'react';
import { Activity, Check, CheckCircle2, Clock, ExternalLink, ListChecks, ShieldCheck, XCircle } from 'lucide-react';
import { JIRA_BASE_URL } from '../lib/env';
import { computeAllEpicMetrics } from '../lib/epicMetrics';

const typeClass = {
  Positive: 'text-[#00875A] bg-green-500/15 border-green-400/30',
  Negative: 'text-[#C9372C] bg-red-500/15 border-red-400/30',
  'Edge Case': 'text-[#B65C00] bg-amber-500/15 border-amber-400/30'
};

const statusDotClass = {
  pending: 'bg-gray-400',
  pass: 'bg-green-400',
  fail: 'bg-red-400',
  running: 'bg-yellow-400'
};

function groupRequirements(requirements) {
  const groups = {};
  (requirements || []).forEach((req) => {
    const key = req.epicKey || 'UNSCOPED';
    if (!groups[key]) groups[key] = [];
    groups[key].push(req);
  });
  return Object.entries(groups).map(([epicKey, reqs]) => ({ epicKey, reqs }));
}

function RTMMatrix({ requirements = [], scenarios = [] }) {
  const [selectedCell, setSelectedCell] = useState(null);

  const grouped = useMemo(() => groupRequirements(requirements), [requirements]);

  // Build epicKey → req[] map for metrics (same shape computeAllEpicMetrics expects)
  const groupedMap = useMemo(() => {
    const map = {};
    grouped.forEach(({ epicKey, reqs }) => { map[epicKey] = reqs; });
    return map;
  }, [grouped]);

  const epicMetrics = useMemo(
    () => computeAllEpicMetrics(groupedMap, scenarios),
    [groupedMap, scenarios]
  );

  const onReqClick = (reqId) => {
    if (!JIRA_BASE_URL || !reqId) return;
    window.open(`${JIRA_BASE_URL}/browse/${reqId}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-[#DFE1E6] bg-[#FFFFFF]">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[#DFE1E6] bg-[#DFE1E6]/40">
              <th className="sticky left-0 z-30 min-w-[140px] border-r border-[#DFE1E6] bg-[#FFFFFF] p-3 text-left text-[#0C66E4]">
                Requirement
              </th>
              <th className="sticky left-[140px] z-30 min-w-[320px] border-r border-[#DFE1E6] bg-[#FFFFFF] p-3 text-left text-[#0C66E4]">
                Description
              </th>
              {scenarios.map((scenario) => (
                <th key={scenario.id} className="min-w-[52px] border-r border-[#DFE1E6] p-0 align-bottom">
                  <div className={`mx-auto my-2 flex h-[150px] w-[42px] items-end justify-center rounded border px-1 py-2 text-xs ${typeClass[scenario.type] || 'text-[#172B4D] bg-[#5E6C84]/15 border-[#5E6C84]/30'}`}>
                    <span style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                      {scenario.id}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 && (
              <tr>
                <td colSpan={scenarios.length + 2} className="p-6 text-center text-[#5E6C84]">
                  No Jira RTM data found for this project yet.
                </td>
              </tr>
            )}

            {grouped.map((group) => {
              const em = epicMetrics[group.epicKey] || {
                total: 0, done: 0, notDone: 0, passed: 0, failed: 0, donePct: 0,
                totalScenarios: 0, passedScenariosStrict: 0, failedScenarios: 0, pendingScenarios: 0, scenarioPassPct: 0,
              };
              return (
              <React.Fragment key={group.epicKey}>
                <tr className="bg-[#5E6C84]/15">
                  <td colSpan={scenarios.length + 2} className="border-y border-[#DFE1E6] px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      {/* Epic label */}
                      <span className="font-semibold text-[#0C66E4]">Epic: {group.epicKey}</span>

                      {em.totalScenarios > 0 ? (
                        <>
                          {/* Scenario pass progress bar */}
                          <div className="flex-1 min-w-[120px] max-w-[180px] h-1.5 bg-[#DFE1E6] rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all"
                              style={{ width: `${em.scenarioPassPct}%` }}
                            />
                          </div>

                          {/* Scenario chips */}
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#5E6C84]/20 border border-[#5E6C84]/40 rounded text-[10px] text-[#0C66E4]">
                            <Activity className="w-3 h-3" />
                            {em.totalScenarios} scenario{em.totalScenarios !== 1 ? 's' : ''}
                          </span>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 border border-green-500/20 rounded text-[10px] text-[#00875A]">
                            <ShieldCheck className="w-3 h-3" />
                            {em.passedScenariosStrict} passing
                          </span>
                          {em.failedScenarios > 0 && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-[#C9372C]">
                              <XCircle className="w-3 h-3" />
                              {em.failedScenarios} failing
                            </span>
                          )}
                          {em.pendingScenarios > 0 && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-500/10 border border-yellow-500/20 rounded text-[10px] text-yellow-300">
                              <Clock className="w-3 h-3" />
                              {em.pendingScenarios} pending
                            </span>
                          )}

                          {/* Divider */}
                          <span className="text-[#5E6C84] text-[10px]">|</span>

                          {/* Test-case chips */}
                          {em.total > 0 ? (
                            <>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#5E6C84]/20 border border-[#5E6C84]/40 rounded text-[10px] text-[#0C66E4]">
                                <ListChecks className="w-3 h-3" />
                                {em.total} test case{em.total !== 1 ? 's' : ''}
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 border border-green-500/20 rounded text-[10px] text-[#00875A]">
                                <CheckCircle2 className="w-3 h-3" />
                                {em.passed} passed
                              </span>
                              {em.failed > 0 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-[#C9372C]">
                                  <XCircle className="w-3 h-3" />
                                  {em.failed} failed
                                </span>
                              )}
                              {em.notDone > 0 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-500/10 border border-yellow-500/20 rounded text-[10px] text-yellow-300">
                                  <Clock className="w-3 h-3" />
                                  {em.notDone} not done
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-[10px] text-[#5E6C84] italic">No test cases yet</span>
                          )}

                          <span className="text-[10px] text-[#5E6C84] ml-auto">
                            {em.scenarioPassPct}% scenarios passing
                          </span>
                        </>
                      ) : (
                        <span className="text-[10px] text-[#5E6C84] italic">No scenarios generated yet</span>
                      )}
                    </div>
                  </td>
                </tr>

                {group.reqs.map((req) => (
                  <tr key={req.reqId} className="border-b border-[#DFE1E6] hover:bg-[#DFE1E6]/40">
                    <td className="sticky left-0 z-20 border-r border-[#DFE1E6] bg-[#FFFFFF] p-3">
                      <button
                        type="button"
                        onClick={() => onReqClick(req.reqId)}
                        className="inline-flex items-center gap-1 rounded-full border border-[#5E6C84]/40 bg-[#5E6C84]/15 px-2 py-1 text-xs font-semibold text-[#0C66E4] hover:bg-[#5E6C84]/25"
                      >
                        {req.reqId}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </td>
                    <td className="sticky left-[140px] z-20 border-r border-[#DFE1E6] bg-[#FFFFFF] p-3 text-[#172B4D]">
                      {req.description}
                    </td>

                    {scenarios.map((scenario) => {
                      const linked = scenario.relatedReq === req.reqId;
                      const status = (scenario.status || 'pending').toLowerCase();

                      return (
                        <td key={`${req.reqId}-${scenario.id}`} className="border-r border-[#DFE1E6] p-2 text-center">
                          {linked ? (
                            <button
                              type="button"
                              onClick={() => setSelectedCell({ req, scenario })}
                              className="mx-auto flex h-6 w-6 items-center justify-center rounded-full border border-[#5E6C84]/40 bg-[#DFE1E6]"
                              title={`Open scenario ${scenario.id}`}
                            >
                              <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass[status] || statusDotClass.pending}`} />
                              <Check className="absolute h-3 w-3 text-[#172B4D] opacity-80" />
                            </button>
                          ) : (
                            <span className="mx-auto block h-4 w-4 rounded border border-[#DFE1E6]" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-[#DFE1E6] bg-[#FFFFFF] p-4 text-sm text-[#172B4D]">
        <div className="mb-2 font-semibold text-[#0C66E4]">Status Legend</div>
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-gray-400" />Pending</span>
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />Running</span>
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-green-400" />Pass</span>
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-red-400" />Fail</span>
        </div>
      </div>

      {selectedCell && (
        <div className="rounded-xl border border-[#5E6C84]/50 bg-[#FFFFFF] p-4 text-sm text-[#172B4D]">
          <div className="mb-1 text-xs uppercase tracking-wider text-[#5E6C84]">Scenario Details</div>
          <div className="font-semibold text-[#0C66E4]">{selectedCell.scenario.id} · {selectedCell.scenario.title}</div>
          <p className="mt-2 text-[#172B4D]/90">{selectedCell.scenario.description}</p>
          <div className="mt-2 text-xs text-[#5E6C84]">Linked requirement: {selectedCell.req.reqId}</div>
        </div>
      )}
    </div>
  );
}

export default RTMMatrix;
