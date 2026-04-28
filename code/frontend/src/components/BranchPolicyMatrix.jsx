import React from 'react';
import { useAppContext } from '../App';
import { Check, X, GitBranch, ArrowRight, Shield, Zap, RefreshCw } from 'lucide-react';

function BranchPolicyMatrix() {
  const { branchPolicies } = useAppContext();

  return (
    <div className="bg-[#FFFFFF] rounded-xl border border-[#DFE1E6] overflow-hidden">
      <div className="p-4 border-b border-[#DFE1E6]">
        <div className="flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-[#5E6C84]" />
          <h3 className="text-lg font-semibold text-[#172B4D]">Branch Policy Matrix</h3>
        </div>
        <p className="text-sm text-[#5E6C84] mt-1">Automated testing and merge policies per branch pattern</p>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[#DFE1E6]">
              <th className="px-4 py-3 text-left text-xs font-medium text-[#5E6C84] uppercase tracking-wider">Source Branch</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#5E6C84] uppercase tracking-wider">
                <ArrowRight className="w-4 h-4 mx-auto" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[#5E6C84] uppercase tracking-wider">Target Branch</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#5E6C84] uppercase tracking-wider">
                <div className="flex items-center justify-center gap-1">
                  <Shield className="w-4 h-4" />
                  <span>Required Tests</span>
                </div>
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#5E6C84] uppercase tracking-wider">
                <div className="flex items-center justify-center gap-1">
                  <Zap className="w-4 h-4" />
                  <span>Auto Merge</span>
                </div>
              </th>
              <th className="px-4 py-3 text-center text-xs font-medium text-[#5E6C84] uppercase tracking-wider">
                <div className="flex items-center justify-center gap-1">
                  <RefreshCw className="w-4 h-4" />
                  <span>Self-Healing</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#DFE1E6]">
            {branchPolicies.map((policy, index) => (
              <tr key={index} className="hover:bg-[#DFE1E6]/50 transition-colors">
                <td className="px-4 py-4">
                  <code className="px-2 py-1 bg-[#DFE1E6] rounded text-sm text-[#0C66E4]">
                    {policy.source}
                  </code>
                </td>
                <td className="px-4 py-4 text-center">
                  <ArrowRight className="w-4 h-4 text-[#5E6C84] mx-auto" />
                </td>
                <td className="px-4 py-4">
                  <code className="px-2 py-1 bg-[#DFE1E6] rounded text-sm text-[#00875A]">
                    {policy.target}
                  </code>
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
      </div>
    </div>
  );
}

export default BranchPolicyMatrix;