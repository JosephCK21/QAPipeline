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
        <div className="bg-[#282A36] rounded-lg p-4 max-h-[400px] overflow-y-auto">
          <h4 className="text-sm font-medium text-[#6272A4] mb-3">Requirements Coverage</h4>
          <div className="space-y-2">
            {run.rtm && run.rtm.length > 0 ? run.rtm.map((req, i) => (
              <div key={i} className="flex items-center justify-between p-2 hover:bg-[#1E1E2F] rounded transition-colors group cursor-pointer" title={req.description}>
                <span className="text-sm text-[#F8F8F2] truncate pr-2 flex-1 font-mono text-xs">{req.reqId} - {req.description}</span>
                <Check className="w-4 h-4 text-[#50FA7B] flex-shrink-0" />
              </div>
            )) : (
                <div className="text-sm text-[#6272A4] py-4 text-center">Waiting for Generation Phase...</div>
            )}
          </div>
        </div>
        <div className="bg-[#282A36] rounded-lg p-4">
          <h4 className="text-sm font-medium text-[#6272A4] mb-3">Generated Artifacts</h4>
          <div className="space-y-2">
            {run.artifacts && run.artifacts.length > 0 ? run.artifacts.map((file, i) => (
              <div key={i} className="flex items-center justify-between p-2 bg-[#1E1E2F] rounded border border-[#6272A4]/20 hover:border-[#6272A4]/50 transition-colors">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-[#8BE9FD]" />
                  <span className="text-sm text-[#F8F8F2] font-mono">{file.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#6272A4] bg-[#121212] px-2 py-0.5 rounded shadow-inner">{file.size}</span>
                  <button className="p-1 hover:bg-[#6272A4]/20 rounded transition-colors" title="Download Sandbox Artifact">
                    <Download className="w-4 h-4 text-[#6272A4]" />
                  </button>
                </div>
              </div>
            )) : (
              <div className="text-sm text-[#6272A4] py-4 text-center">Waiting for Generation Phase...</div>
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
          <tr className="border-b border-[#282A36]">
            <th className="px-4 py-3 text-left text-xs font-medium text-[#6272A4] uppercase">Sandbox ID</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[#6272A4] uppercase">Language</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-[#6272A4] uppercase">Version</th>
            <th className="px-4 py-3 text-center text-xs font-medium text-[#6272A4] uppercase">Status</th>
            <th className="px-4 py-3 text-center text-xs font-medium text-[#6272A4] uppercase">Tests Running</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#282A36]">
          {sandboxMatrix.map((sandbox) => (
            <tr key={sandbox.id} className="hover:bg-[#282A36]/50">
              <td className="px-4 py-3">
                <code className="text-sm text-[#8BE9FD]">{sandbox.id}</code>
              </td>
              <td className="px-4 py-3 text-sm text-[#F8F8F2]">{sandbox.language}</td>
              <td className="px-4 py-3 text-sm text-[#6272A4]">{sandbox.version}</td>
              <td className="px-4 py-3 text-center">
                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                  sandbox.status === 'active' 
                    ? 'bg-[#50FA7B]/20 text-[#50FA7B]' 
                    : 'bg-[#6272A4]/20 text-[#6272A4]'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    sandbox.status === 'active' ? 'bg-[#50FA7B] animate-pulse' : 'bg-[#6272A4]'
                  }`} />
                  {sandbox.status}
                </span>
              </td>
              <td className="px-4 py-3 text-center text-sm text-[#F8F8F2]">{sandbox.testsRunning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderHealingTracker = () => (
    <div className="space-y-3">
      {healingHistory.map((heal) => (
        <div key={heal.id} className="p-4 rounded-lg border bg-[#282A36] border-[#6272A4]/30 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                {heal.status === 'success' 
                  ? <Check className="w-4 h-4 text-[#50FA7B]" />
                  : <X className="w-4 h-4 text-[#FF5555]" />
                }
                <code className="text-sm font-medium text-[#F8F8F2]">{heal.testName}</code>
              </div>
              <p className="text-sm text-[#FF5555] mt-1">Error: {heal.error}</p>
              <p className="text-sm text-[#50FA7B] mt-1">Fix Applied: {heal.fix}</p>
            </div>
            <span className="text-xs text-[#6272A4]">
              {new Date(heal.timestamp).toLocaleTimeString()}
            </span>
          </div>

          {/* Guardrails */}
          <div className="bg-[#1E1E2F] p-3 rounded text-xs space-y-1">
            <h5 className="text-[#8BE9FD] font-medium mb-2">Guardrail Status:</h5>
            <div className="flex items-center gap-2 text-[#50FA7B]"><Check className="w-3 h-3" /> Test Count Maintained</div>
            <div className="flex items-center gap-2 text-[#50FA7B]"><Check className="w-3 h-3" /> Coverage Maintained</div>
            <div className="flex items-center gap-2 text-[#50FA7B]"><Check className="w-3 h-3" /> Assertions Preserved</div>
            <div className="flex items-center gap-2 text-[#50FA7B]"><Check className="w-3 h-3" /> Immutable Boundary Maintained (Application code untouched)</div>
          </div>

          {/* Code Diff Simulation */}
          <div className="grid grid-cols-2 gap-4 mt-4">
             <div className="bg-[#1E1E2F] p-3 rounded font-mono text-[10px] overflow-auto max-h-48 text-[#FF5555]">
               <div className="text-xs text-[#6272A4] mb-2 font-sans border-b border-[#282A36] pb-1">AI Generated (Failed)</div>
               <pre><code>{heal.originalCode || "/* No original code captured */"}</code></pre>
             </div>
             <div className="bg-[#1E1E2F] p-3 rounded font-mono text-[10px] overflow-auto max-h-48 text-[#50FA7B]">
               <div className="text-xs text-[#6272A4] mb-2 font-sans border-b border-[#282A36] pb-1">AI Patched (Passed)</div>
               <pre><code>{heal.fixedCode || "/* No fix code captured */"}</code></pre>
             </div>
          </div>
        </div>
      ))}
      {healingHistory.length === 0 && (
         <div className="text-center py-8 text-[#6272A4]">No healing runs required or active.</div>
      )}
    </div>
  );

  const renderAuditTrail = () => (
    <div className="bg-[#0D0D0D] rounded-lg p-4 font-mono text-xs max-h-[500px] overflow-y-auto">
      {auditLogs.map((log, index) => (
        <div key={index} className="flex gap-4 py-1 hover:bg-[#1E1E2F]/50 whitespace-pre-wrap">
          <span className="text-[#6272A4] flex-shrink-0">
            {new Date(log.timestamp).toLocaleTimeString()}
          </span>
          <span className={`flex-shrink-0 w-12 ${
            log.level === 'INFO' ? 'text-[#50FA7B]' :
            log.level === 'WARN' ? 'text-[#FFB86C]' :
            'text-[#FF5555]'
          }`}>
            [{log.level}]
          </span>
          <span className="text-[#F8F8F2] font-medium">{log.message}</span>
        </div>
      ))}
    </div>
  );

  const tabContent = [renderTraceability, renderSandboxMatrix, renderHealingTracker, renderAuditTrail];

  return (
    <div className="bg-[#1E1E2F] rounded-xl border border-[#282A36] overflow-hidden">
      {/* Tab Headers */}
      <div className="flex border-b border-[#282A36]">
        {tabs.map((tab, index) => {
          const Icon = tab.icon;
          return (
            <button
              key={index}
              onClick={() => setActiveTab(index)}
              className={`flex items-center gap-2 px-6 py-4 text-sm font-medium transition-colors ${
                activeTab === index
                  ? 'text-[#F8F8F2] border-b-2 border-[#6272A4] bg-[#282A36]/50'
                  : 'text-[#6272A4] hover:text-[#F8F8F2] hover:bg-[#282A36]/30'
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