import React from 'react';
import { Check, X, GitBranch, ArrowRight, Shield, Zap, RefreshCw } from 'lucide-react';

/** Placeholder until branch policy data is wired from the backend. */
const branchPolicies = [];

function BranchPolicyMatrix({ darkMode = false }) {
  const u = darkMode
    ? {
        card: 'bg-[#0D1117] rounded-xl border border-[#30363D]',
        headerBorder: 'border-b border-[#30363D]',
        muted: 'text-[#8B949E]',
        heading: 'text-[#E6EDF3]',
        theadBg: 'bg-[#21262D]',
        theadText: 'text-[#8B949E]',
        empty: 'text-[#8B949E]',
        divide: 'divide-[#30363D]',
        rowHover: 'hover:bg-[#21262D]/60',
        codeSrc: 'bg-[#21262D] text-[#58A6FF]',
        codeTgt: 'bg-[#21262D] text-[#3FB950]',
      }
    : {
        card: 'bg-[#FFFFFF] rounded-xl border border-[#DFE1E6]',
        headerBorder: 'border-b border-[#DFE1E6]',
        muted: 'text-[#5E6C84]',
        heading: 'text-[#172B4D]',
        theadBg: 'bg-[#DFE1E6]',
        theadText: 'text-[#5E6C84]',
        empty: 'text-[#5E6C84]',
        divide: 'divide-[#DFE1E6]',
        rowHover: 'hover:bg-[#DFE1E6]/50',
        codeSrc: 'bg-[#DFE1E6] text-[#0C66E4]',
        codeTgt: 'bg-[#DFE1E6] text-[#00875A]',
      };

  return (
    <div className={u.card}>
      <div className={`p-4 ${u.headerBorder}`}>
        <div className="flex items-center gap-2">
          <GitBranch className={`w-5 h-5 ${u.muted}`} />
          <h3 className={`text-lg font-semibold ${u.heading}`}>Branch Policy Matrix</h3>
        </div>
        <p className={`text-sm mt-1 ${u.muted}`}>Automated testing and merge policies per branch pattern</p>
      </div>

      <div className="overflow-x-auto">
        {branchPolicies.length === 0 ? (
          <p className={`px-4 py-8 text-sm text-center ${u.empty}`}>
            No branch policies loaded. Connect policy data from the API to populate this matrix.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className={u.theadBg}>
                <th className={`px-4 py-3 text-left text-xs font-medium ${u.theadText} uppercase tracking-wider`}>
                  Source Branch
                </th>
                <th className={`px-4 py-3 text-center text-xs font-medium ${u.theadText} uppercase tracking-wider`}>
                  <ArrowRight className="w-4 h-4 mx-auto" />
                </th>
                <th className={`px-4 py-3 text-left text-xs font-medium ${u.theadText} uppercase tracking-wider`}>
                  Target Branch
                </th>
                <th className={`px-4 py-3 text-center text-xs font-medium ${u.theadText} uppercase tracking-wider`}>
                  <div className="flex items-center justify-center gap-1">
                    <Shield className="w-4 h-4" />
                    <span>Required Tests</span>
                  </div>
                </th>
                <th className={`px-4 py-3 text-center text-xs font-medium ${u.theadText} uppercase tracking-wider`}>
                  <div className="flex items-center justify-center gap-1">
                    <Zap className="w-4 h-4" />
                    <span>Auto Merge</span>
                  </div>
                </th>
                <th className={`px-4 py-3 text-center text-xs font-medium ${u.theadText} uppercase tracking-wider`}>
                  <div className="flex items-center justify-center gap-1">
                    <RefreshCw className="w-4 h-4" />
                    <span>Self-Healing</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className={`divide-y ${u.divide}`}>
              {branchPolicies.map((policy, index) => (
                <tr key={index} className={`${u.rowHover} transition-colors`}>
                  <td className="px-4 py-4">
                    <code className={`px-2 py-1 rounded text-sm ${u.codeSrc}`}>{policy.source}</code>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <ArrowRight className={`w-4 h-4 mx-auto ${u.muted}`} />
                  </td>
                  <td className="px-4 py-4">
                    <code className={`px-2 py-1 rounded text-sm ${u.codeTgt}`}>{policy.target}</code>
                  </td>
                  <td className="px-4 py-4 text-center">
                    {policy.requiredTests ? (
                      <div className="inline-flex items-center justify-center w-6 h-6 bg-[#00875A]/20 rounded-full">
                        <Check className="w-4 h-4 text-[#00875A]" />
                      </div>
                    ) : (
                      <div className="inline-flex items-center justify-center w-6 h-6 bg-[#C9372C]/20 rounded-full">
                        <X className="w-4 h-4 text-[#C9372C]" />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    {policy.autoMerge ? (
                      <div className="inline-flex items-center justify-center w-6 h-6 bg-[#00875A]/20 rounded-full">
                        <Check className="w-4 h-4 text-[#00875A]" />
                      </div>
                    ) : (
                      <div className="inline-flex items-center justify-center w-6 h-6 bg-[#B65C00]/20 rounded-full">
                        <X className="w-4 h-4 text-[#B65C00]" />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    {policy.healingEnabled ? (
                      <div className="inline-flex items-center justify-center w-6 h-6 bg-[#00875A]/20 rounded-full">
                        <Check className="w-4 h-4 text-[#00875A]" />
                      </div>
                    ) : (
                      <div className="inline-flex items-center justify-center w-6 h-6 bg-[#5E6C84]/20 rounded-full">
                        <X className="w-4 h-4 text-[#5E6C84]" />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default BranchPolicyMatrix;
