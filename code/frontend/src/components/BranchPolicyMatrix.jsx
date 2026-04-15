import React from 'react';
import { useAppContext } from '../App';
import { Check, X, GitBranch, ArrowRight, Shield, Zap, RefreshCw } from 'lucide-react';

function BranchPolicyMatrix() {
  const { branchPolicies } = useAppContext();

  return (
    <div className="bg-[#1E1E2F] rounded-xl border border-[#282A36] overflow-hidden">
      <div className="p-4 border-b border-[#282A36]">
        <div className="flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-[#6272A4]" />
          <h3 className="text-lg font-semibold text-[#F8F8F2]">Branch Policy Matrix</h3>
        </div>
        <p className="text-sm text-[#6272A4] mt-1">Automated testing and merge policies per branch pattern</p>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[#282A36]">
              <th className="px-4 py-3 text-left text-xs font-medium text-[#6272A4] uppercase tracking-wider">Source Branch</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#6272A4] uppercase tracking-wider">
                <ArrowRight className="w-4 h-4 mx-auto" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[#6272A4] uppercase tracking-wider">Target Branch</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#6272A4] uppercase tracking-wider">
                <div className="flex items-center justify-center gap-1">
                  <Shield className="w-4 h-4" />
                  <span>Required Tests</span>
                </div>
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#6272A4] uppercase tracking-wider">
                <div className="flex items-center justify-center gap-1">
                  <Zap className="w-4 h-4" />
                  <span>Auto Merge</span>
                </div>
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#6272A4] uppercase tracking-wider">
                <div className="flex items-center justify-center gap-1">
                  <RefreshCw className="w-4 h-4" />
                  <span>Self-Healing</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#282A36]">
            {branchPolicies.map((policy, index) => (
              <tr key={index} className="hover:bg-[#282A36]/50 transition-colors">
                <td className="px-4 py-4">
                  <code className="px-2 py-1 bg-[#282A36] rounded text-sm text-[#8BE9FD]">
                    {policy.source}
                  </code>
                </td>
                <td className="px-4 py-4 text-center">
                  <ArrowRight className="w-4 h-4 text-[#6272A4] mx-auto" />
                </td>
                <td className="px-4 py-4">
                  <code className="px-2 py-1 bg-[#282A36] rounded text-sm text-[#50FA7B]">
                    {policy.target}
                  </code>
                </td>
                <td className="px-4 py-4 text-center">
                  {policy.requiredTests ? (
                    <div className="inline-flex items-center justify-center w-6 h-6 bg-[#50FA7B]/20 rounded-full">
                      <Check className="w-4 h-4 text-[#50FA7B]" />
                    </div>
                  ) : (
                    <div className="inline-flex items-center justify-center w-6 h-6 bg-[#FF5555]/20 rounded-full">
                      <X className="w-4 h-4 text-[#FF5555]" />
                    </div>
                  )}
                </td>
                <td className="px-4 py-4 text-center">
                  {policy.autoMerge ? (
                    <div className="inline-flex items-center justify-center w-6 h-6 bg-[#50FA7B]/20 rounded-full">
                      <Check className="w-4 h-4 text-[#50FA7B]" />
                    </div>
                  ) : (
                    <div className="inline-flex items-center justify-center w-6 h-6 bg-[#FFB86C]/20 rounded-full">
                      <X className="w-4 h-4 text-[#FFB86C]" />
                    </div>
                  )}
                </td>
                <td className="px-4 py-4 text-center">
                  {policy.healingEnabled ? (
                    <div className="inline-flex items-center justify-center w-6 h-6 bg-[#50FA7B]/20 rounded-full">
                      <Check className="w-4 h-4 text-[#50FA7B]" />
                    </div>
                  ) : (
                    <div className="inline-flex items-center justify-center w-6 h-6 bg-[#6272A4]/20 rounded-full">
                      <X className="w-4 h-4 text-[#6272A4]" />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default BranchPolicyMatrix;