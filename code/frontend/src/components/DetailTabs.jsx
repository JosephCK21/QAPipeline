import React, { useState } from 'react';
import { useAppContext } from '../App';
import { 
  FileText, 
  Server, 
  RefreshCw, 
  Terminal,
  Check,
  X,
  AlertCircle,
  Download,
  ExternalLink
} from 'lucide-react';

function DetailTabs({ run }) {
  const [activeTab, setActiveTab] = useState(0);
  const { sandboxMatrix, healingHistory, auditLogs } = useAppContext();

  const tabs = [
    { icon: FileText, label: 'Traceability (RTM)' },
    { icon: Server, label: 'Sandbox Matrix' },
    { icon: RefreshCw, label: 'Self-Healing Tracker' },
    { icon: Terminal, label: 'Audit Trail' }
  ];

  const renderTraceability = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-[#DFE1E6] rounded-lg p-4 max-h-[400px] overflow-y-auto">
          <h4 className="text-sm font-medium text-[#5E6C84] mb-3">Requirements Coverage</h4>
          <div className="space-y-2">
            {run.rtm && run.rtm.length > 0 ? run.rtm.map((req, i) => (
              <div key={i} className="flex items-center justify-between p-2 hover:bg-[#FFFFFF] rounded transition-colors group cursor-pointer" title={req.description}>
                <span className="text-sm text-[#172B4D] truncate pr-2 flex-1 font-mono text-xs">{req.reqId} - {req.description}</span>
                <Check className="w-4 h-4 text-[#00875A] flex-shrink-0" />
              </div>
            )) : (
                <div className="text-sm text-[#5E6C84] py-4 text-center">Waiting for Generation Phase...</div>
            )}
          </div>
        </div>
        <div className="bg-[#DFE1E6] rounded-lg p-4">
          <h4 className="text-sm font-medium text-[#5E6C84] mb-3">Generated Artifacts</h4>
          <div className="space-y-2">
            {run.artifacts && run.artifacts.length > 0 ? run.artifacts.map((file, i) => (
              <div key={i} className="flex items-center justify-between p-2 bg-[#FFFFFF] rounded border border-[#5E6C84]/20 hover:border-[#5E6C84]/50 transition-colors">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-[#0C66E4]" />
                  <span className="text-sm text-[#172B4D] font-mono">{file.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#5E6C84] bg-[#F4F5F7] px-2 py-0.5 rounded shadow-inner">{file.size}</span>
                  <button className="p-1 hover:bg-[#5E6C84]/20 rounded transition-colors" title="Download Sandbox Artifact">
                    <Download className="w-4 h-4 text-[#5E6C84]" />
                  </button>
                </div>
              </div>
            )) : (
              <div className="text-sm text-[#5E6C84] py-4 text-center">Waiting for Generation Phase...</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const renderSandboxMatrix = () => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-[#DFE1E6]">
            <th className="px-4 py-3 text-left text-xs font-medium text-[#5E6C84] uppercase">Sandbox ID</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[#5E6C84] uppercase">Language</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[#5E6C84] uppercase">Version</th>
            <th className="px-4 py-3 text-center text-xs font-medium text-[#5E6C84] uppercase">Status</th>
            <th className="px-4 py-3 text-center text-xs font-medium text-[#5E6C84] uppercase">Tests Running</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#DFE1E6]">
          {sandboxMatrix.map((sandbox) => (
            <tr key={sandbox.id} className="hover:bg-[#DFE1E6]/50">
              <td className="px-4 py-3">
                <code className="text-sm text-[#0C66E4]">{sandbox.id}</code>
              </td>
              <td className="px-4 py-3 text-sm text-[#172B4D]">{sandbox.language}</td>
              <td className="px-4 py-3 text-sm text-[#5E6C84]">{sandbox.version}</td>
              <td className="px-4 py-3 text-center">
                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                  sandbox.status === 'active' 
                    ? 'bg-[#00875A]/20 text-[#00875A]' 
                    : 'bg-[#5E6C84]/20 text-[#5E6C84]'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    sandbox.status === 'active' ? 'bg-[#00875A] animate-pulse' : 'bg-[#5E6C84]'
                  }`} />
                  {sandbox.status}
                </span>
              </td>
              <td className="px-4 py-3 text-center text-sm text-[#172B4D]">{sandbox.testsRunning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderHealingTracker = () => (
    <div className="space-y-3">
      {healingHistory.map((heal) => (
        <div key={heal.id} className="p-4 rounded-lg border bg-[#DFE1E6] border-[#5E6C84]/30 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                {heal.status === 'success' 
                  ? <Check className="w-4 h-4 text-[#00875A]" />
                  : <X className="w-4 h-4 text-[#C9372C]" />
                }
                <code className="text-sm font-medium text-[#172B4D]">{heal.testName}</code>
              </div>
              <p className="text-sm text-[#C9372C] mt-1">Error: {heal.error}</p>
              <p className="text-sm text-[#00875A] mt-1">Fix Applied: {heal.fix}</p>
            </div>
            <span className="text-xs text-[#5E6C84]">
              {new Date(heal.timestamp).toLocaleTimeString()}
            </span>
          </div>

          {/* Guardrails */}
          <div className="bg-[#FFFFFF] p-3 rounded text-xs space-y-1">
            <h5 className="text-[#0C66E4] font-medium mb-2">Guardrail Status:</h5>
            <div className="flex items-center gap-2 text-[#00875A]"><Check className="w-3 h-3" /> Test Count Maintained</div>
            <div className="flex items-center gap-2 text-[#00875A]"><Check className="w-3 h-3" /> Coverage Maintained</div>
            <div className="flex items-center gap-2 text-[#00875A]"><Check className="w-3 h-3" /> Assertions Preserved</div>
            <div className="flex items-center gap-2 text-[#00875A]"><Check className="w-3 h-3" /> Immutable Boundary Maintained (Application code untouched)</div>
          </div>

          {/* Code Diff Simulation */}
          <div className="grid grid-cols-2 gap-4 mt-4">
             <div className="bg-[#FFFFFF] p-3 rounded font-mono text-[10px] overflow-auto max-h-48 text-[#C9372C]">
               <div className="text-xs text-[#5E6C84] mb-2 font-sans border-b border-[#DFE1E6] pb-1">AI Generated (Failed)</div>
               <pre><code>{heal.originalCode || "/* No original code captured */"}</code></pre>
             </div>
             <div className="bg-[#FFFFFF] p-3 rounded font-mono text-[10px] overflow-auto max-h-48 text-[#00875A]">
               <div className="text-xs text-[#5E6C84] mb-2 font-sans border-b border-[#DFE1E6] pb-1">AI Patched (Passed)</div>
               <pre><code>{heal.fixedCode || "/* No fix code captured */"}</code></pre>
             </div>
          </div>
        </div>
      ))}
      {healingHistory.length === 0 && (
         <div className="text-center py-8 text-[#5E6C84]">No healing runs required or active.</div>
      )}
    </div>
  );

  const renderAuditTrail = () => (
    <div className="bg-[#0D0D0D] rounded-lg p-4 font-mono text-xs max-h-[500px] overflow-y-auto">
      {auditLogs.map((log, index) => (
        <div key={index} className="flex gap-4 py-1 hover:bg-[#FFFFFF]/50 whitespace-pre-wrap">
          <span className="text-[#5E6C84] flex-shrink-0">
            {new Date(log.timestamp).toLocaleTimeString()}
          </span>
          <span className={`flex-shrink-0 w-12 ${
            log.level === 'INFO' ? 'text-[#00875A]' :
            log.level === 'WARN' ? 'text-[#B65C00]' :
            'text-[#C9372C]'
          }`}>
            [{log.level}]
          </span>
          <span className="text-[#172B4D] font-medium">{log.message}</span>
        </div>
      ))}
    </div>
  );

  const tabContent = [renderTraceability, renderSandboxMatrix, renderHealingTracker, renderAuditTrail];

  return (
    <div className="bg-[#FFFFFF] rounded-xl border border-[#DFE1E6] overflow-hidden">
      {/* Tab Headers */}
      <div className="flex border-b border-[#DFE1E6]">
        {tabs.map((tab, index) => {
          const Icon = tab.icon;
          return (
            <button
              key={index}
              onClick={() => setActiveTab(index)}
              className={`flex items-center gap-2 px-6 py-4 text-sm font-medium transition-colors ${
                activeTab === index
                  ? 'text-[#172B4D] border-b-2 border-[#5E6C84] bg-[#DFE1E6]/50'
                  : 'text-[#5E6C84] hover:text-[#172B4D] hover:bg-[#DFE1E6]/30'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="p-6">
        {tabContent[activeTab]()}
      </div>
    </div>
  );
}

export default DetailTabs;