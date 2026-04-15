import React, { useMemo, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { JIRA_BASE_URL } from '../lib/env';

const typeClass = {
  Positive: 'text-green-300 bg-green-500/15 border-green-400/30',
  Negative: 'text-red-300 bg-red-500/15 border-red-400/30',
  'Edge Case': 'text-amber-300 bg-amber-500/15 border-amber-400/30'
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

  const onReqClick = (reqId) => {
    if (!JIRA_BASE_URL || !reqId) return;
    window.open(`${JIRA_BASE_URL}/browse/${reqId}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-[#282A36] bg-[#1E1E2F]">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[#282A36] bg-[#282A36]/40">
              <th className="sticky left-0 z-30 min-w-[140px] border-r border-[#282A36] bg-[#1E1E2F] p-3 text-left text-[#8BE9FD]">
                Requirement
              </th>
              <th className="sticky left-[140px] z-30 min-w-[320px] border-r border-[#282A36] bg-[#1E1E2F] p-3 text-left text-[#8BE9FD]">
                Description
              </th>
              {scenarios.map((scenario) => (
                <th key={scenario.id} className="min-w-[52px] border-r border-[#282A36] p-0 align-bottom">
                  <div className={`mx-auto my-2 flex h-[150px] w-[42px] items-end justify-center rounded border px-1 py-2 text-xs ${typeClass[scenario.type] || 'text-[#F8F8F2] bg-[#6272A4]/15 border-[#6272A4]/30'}`}>
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
                <td colSpan={scenarios.length + 2} className="p-6 text-center text-[#6272A4]">
                  No Jira RTM data found for this project yet.
                </td>
              </tr>
            )}

            {grouped.map((group) => (
              <React.Fragment key={group.epicKey}>
                <tr className="bg-[#6272A4]/15">
                  <td colSpan={scenarios.length + 2} className="border-y border-[#282A36] px-4 py-2 font-semibold text-[#8BE9FD]">
                    Epic: {group.epicKey}
                  </td>
                </tr>

                {group.reqs.map((req) => (
                  <tr key={req.reqId} className="border-b border-[#282A36] hover:bg-[#282A36]/40">
                    <td className="sticky left-0 z-20 border-r border-[#282A36] bg-[#1E1E2F] p-3">
                      <button
                        type="button"
                        onClick={() => onReqClick(req.reqId)}
                        className="inline-flex items-center gap-1 rounded-full border border-[#6272A4]/40 bg-[#6272A4]/15 px-2 py-1 text-xs font-semibold text-[#8BE9FD] hover:bg-[#6272A4]/25"
                      >
                        {req.reqId}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </td>
                    <td className="sticky left-[140px] z-20 border-r border-[#282A36] bg-[#1E1E2F] p-3 text-[#F8F8F2]">
                      {req.description}
                    </td>

                    {scenarios.map((scenario) => {
                      const linked = scenario.relatedReq === req.reqId;
                      const status = (scenario.status || 'pending').toLowerCase();

                      return (
                        <td key={`${req.reqId}-${scenario.id}`} className="border-r border-[#282A36] p-2 text-center">
                          {linked ? (
                            <button
                              type="button"
                              onClick={() => setSelectedCell({ req, scenario })}
                              className="mx-auto flex h-6 w-6 items-center justify-center rounded-full border border-[#6272A4]/40 bg-[#282A36]"
                              title={`Open scenario ${scenario.id}`}
                            >
                              <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass[status] || statusDotClass.pending}`} />
                              <Check className="absolute h-3 w-3 text-[#F8F8F2] opacity-80" />
                            </button>
                          ) : (
                            <span className="mx-auto block h-4 w-4 rounded border border-[#282A36]" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-[#282A36] bg-[#1E1E2F] p-4 text-sm text-[#F8F8F2]">
        <div className="mb-2 font-semibold text-[#8BE9FD]">Status Legend</div>
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-gray-400" />Pending</span>
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />Running</span>
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-green-400" />Pass</span>
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-red-400" />Fail</span>
        </div>
      </div>

      {selectedCell && (
        <div className="rounded-xl border border-[#6272A4]/50 bg-[#1E1E2F] p-4 text-sm text-[#F8F8F2]">
          <div className="mb-1 text-xs uppercase tracking-wider text-[#6272A4]">Scenario Details</div>
          <div className="font-semibold text-[#8BE9FD]">{selectedCell.scenario.id} · {selectedCell.scenario.title}</div>
          <p className="mt-2 text-[#F8F8F2]/90">{selectedCell.scenario.description}</p>
          <div className="mt-2 text-xs text-[#6272A4]">Linked requirement: {selectedCell.req.reqId}</div>
        </div>
      )}
    </div>
  );
}

export default RTMMatrix;
