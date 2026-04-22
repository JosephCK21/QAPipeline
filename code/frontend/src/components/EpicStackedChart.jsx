import React from 'react';
import { CheckCircle2, XCircle, Clock } from 'lucide-react';

/**
 * EpicStackedChart
 *
 * Horizontal stacked bar chart — one row per Epic.
 *
 * Props:
 *   epicMetrics  — Record<epicKey, { totalScenarios, passedScenariosStrict, failedScenarios, pendingScenarios }>
 *   darkMode     — boolean
 *   onEpicClick  — optional (epicKey: string) => void  — called when a bar row is clicked
 */
function EpicStackedChart({ epicMetrics = {}, darkMode = false, onEpicClick }) {
  // Build sorted array: highest totalScenarios first
  const entries = Object.values(epicMetrics)
    .filter((em) => em.totalScenarios > 0)
    .sort((a, b) => b.totalScenarios - a.totalScenarios);

  if (entries.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center py-14 rounded-xl border border-dashed ${
        darkMode ? 'border-[#30363D] text-[#6E7681]' : 'border-[#DFE1E6] text-[#8993A4]'
      }`}>
        <Clock className="w-8 h-8 mb-3 opacity-40" />
        <p className="text-sm">No Epic scenario data yet. Sync Jira and trigger a PR to populate.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {entries.map((em) => {
        const { epicKey, totalScenarios, passedScenariosStrict, failedScenarios, pendingScenarios } = em;

        const passedPct  = totalScenarios > 0 ? (passedScenariosStrict / totalScenarios) * 100 : 0;
        const failedPct  = totalScenarios > 0 ? (failedScenarios        / totalScenarios) * 100 : 0;
        const pendingPct = totalScenarios > 0 ? (pendingScenarios        / totalScenarios) * 100 : 0;

        // Normalise to avoid float rounding gaps
        const total = passedPct + failedPct + pendingPct;
        const normPass    = total > 0 ? (passedPct  / total) * 100 : 0;
        const normFail    = total > 0 ? (failedPct  / total) * 100 : 0;
        const normPending = total > 0 ? (pendingPct / total) * 100 : 0;

        const isClickable = typeof onEpicClick === 'function';

        return (
          <div
            key={epicKey}
            className={`group ${isClickable ? 'cursor-pointer' : ''}`}
            onClick={isClickable ? () => onEpicClick(epicKey) : undefined}
          >
            {/* ── Label above bar ──────────────────────────────────── */}
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${
                  darkMode ? 'bg-[rgba(56,139,253,0.15)] text-[#58A6FF]' : 'bg-[#E9F2FF] text-[#0747A6]'
                }`}>
                  Epic
                </span>
                <span className={`text-sm font-semibold ${
                  isClickable
                    ? darkMode
                      ? 'text-[#E6EDF3] group-hover:text-[#58A6FF] transition-colors'
                      : 'text-[#172B4D] group-hover:text-[#0C66E4] transition-colors'
                    : darkMode ? 'text-[#E6EDF3]' : 'text-[#172B4D]'
                }`}>
                  {epicKey}
                </span>
              </div>
              <span className={`text-xs font-medium tabular-nums ${darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'}`}>
                {totalScenarios} scenario{totalScenarios !== 1 ? 's' : ''}
              </span>
            </div>

            {/* ── Stacked Bar ──────────────────────────────────────── */}
            <div className={`w-full h-6 rounded-lg overflow-hidden flex ${
              darkMode ? 'bg-[#21262D]' : 'bg-[#DFE1E6]'
            } ${isClickable ? 'group-hover:shadow-md transition-shadow' : ''}`}>
              {/* Green — passed */}
              {normPass > 0 && (
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-green-400 transition-all duration-700 ease-out flex items-center justify-center overflow-hidden"
                  style={{ width: `${normPass}%` }}
                  title={`${passedScenariosStrict} passed`}
                >
                  {normPass >= 10 && (
                    <span className="text-[10px] font-bold text-white drop-shadow-sm select-none">
                      {passedScenariosStrict}
                    </span>
                  )}
                </div>
              )}

              {/* Red — failed */}
              {normFail > 0 && (
                <div
                  className="h-full bg-gradient-to-r from-red-500 to-rose-400 transition-all duration-700 ease-out flex items-center justify-center overflow-hidden"
                  style={{ width: `${normFail}%` }}
                  title={`${failedScenarios} failed`}
                >
                  {normFail >= 10 && (
                    <span className="text-[10px] font-bold text-white drop-shadow-sm select-none">
                      {failedScenarios}
                    </span>
                  )}
                </div>
              )}

              {/* Grey — not tested (pending) */}
              {normPending > 0 && (
                <div
                  className={`h-full transition-all duration-700 ease-out flex items-center justify-center overflow-hidden ${
                    darkMode ? 'bg-[#30363D]' : 'bg-[#C1C7D0]'
                  }`}
                  style={{ width: `${normPending}%` }}
                  title={`${pendingScenarios} not tested`}
                >
                  {normPending >= 10 && (
                    <span className={`text-[10px] font-bold drop-shadow-sm select-none ${
                      darkMode ? 'text-[#6E7681]' : 'text-[#5E6C84]'
                    }`}>
                      {pendingScenarios}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* ── Numeric Summary below bar ────────────────────────── */}
            <div className="flex items-center gap-4 mt-1.5 flex-wrap">
              {passedScenariosStrict > 0 && (
                <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                  darkMode ? 'text-[#3FB950]' : 'text-[#00875A]'
                }`}>
                  <CheckCircle2 className="w-3 h-3" />
                  {passedScenariosStrict} passed
                </span>
              )}
              {failedScenarios > 0 && (
                <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                  darkMode ? 'text-[#F85149]' : 'text-[#C9372C]'
                }`}>
                  <XCircle className="w-3 h-3" />
                  {failedScenarios} failed
                </span>
              )}
              {pendingScenarios > 0 && (
                <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                  darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'
                }`}>
                  <Clock className="w-3 h-3" />
                  {pendingScenarios} not tested
                </span>
              )}
              {/* Edge: all pending */}
              {passedScenariosStrict === 0 && failedScenarios === 0 && pendingScenarios > 0 && (
                <span className={`text-[11px] italic ${darkMode ? 'text-[#6E7681]' : 'text-[#8993A4]'}`}>
                  — awaiting first PR
                </span>
              )}
            </div>

            {/* Subtle divider between rows */}
            <div className={`mt-4 h-px ${darkMode ? 'bg-[#21262D]' : 'bg-[#F1F2F4]'}`} />
          </div>
        );
      })}

      {/* Legend */}
      <div className={`flex items-center gap-5 pt-1 text-[11px] flex-wrap ${
        darkMode ? 'text-[#8B949E]' : 'text-[#5E6C84]'
      }`}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-gradient-to-r from-emerald-500 to-green-400" />
          Passed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-gradient-to-r from-red-500 to-rose-400" />
          Failed
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`inline-block w-3 h-3 rounded-sm ${darkMode ? 'bg-[#30363D]' : 'bg-[#C1C7D0]'}`} />
          Not tested
        </span>
      </div>
    </div>
  );
}

export default EpicStackedChart;
