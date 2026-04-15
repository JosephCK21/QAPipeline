import React, { useState, useEffect } from 'react';
import { useAppContext } from '../App';
import { Bot, User, Activity } from 'lucide-react';

function AgentChatDebug() {
  const { refreshKey } = useAppContext();
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [traces, setTraces] = useState([]);

  useEffect(() => {
    const fetchRuns = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/runs');
        const data = await res.json();
        const sortedData = data.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        setRuns(sortedData);
        
        if (sortedData.length > 0 && !selectedRun) {
            setSelectedRun(sortedData[0].runId);
        }
      } catch (err) {
        console.error('Failed to fetch runs', err);
      }
    };
    fetchRuns();
  }, [refreshKey]);

  useEffect(() => {
    if (runs && runs.length > 0 && selectedRun) {
      const target = runs.find(r => r.runId === selectedRun);
      if (target && target.llm_traces) {
        setTraces(target.llm_traces);
      } else {
        setTraces([]);
      }
    }
  }, [runs, selectedRun]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex justify-between items-center bg-[#1E1E2F] p-4 rounded-xl border border-[#282A36]">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[#F8F8F2] flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#FFB86C]" /> Agent Debug Console
          </h1>
          <p className="text-xs text-gray-400 mt-1">Real-time view of LLM prompts and responses (I/O Traces)</p>
        </div>
        <select 
            className="bg-[#1E1E2F] border border-[#6272A4] text-white rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-[#8BE9FD]"
            value={selectedRun || ''}
            onChange={(e) => setSelectedRun(e.target.value)}
        >
            <option value="" disabled>Select a run</option>
            {runs.map(run => (
                <option key={run.runId} value={run.runId}>{run.runId.substring(0, 8)} - {run.repository?.full_name || 'Repo'} - {run.status}</option>
            ))}
        </select>
      </div>

      <div className="space-y-4">
        {traces.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 bg-[#282A36] rounded-xl border border-[#6272A4]/20">
            <Bot className="w-12 h-12 text-[#6272A4] mb-4 opacity-50" />
            <p className="text-xl font-medium text-gray-500">No agent traces logged yet</p>
            <p className="text-gray-600 mt-2 text-center text-sm">Start a pipeline test to watch the LLM think and invoke tools.</p>
          </div>
        ) : (
          traces.map((trace, index) => (
            <div key={index} className={`flex ${trace.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div 
                className={`max-w-[80%] rounded-2xl p-4 shadow-md ${
                  trace.role === 'user' 
                    ? 'bg-[#6272A4] text-white border border-[#8BE9FD]/20 ml-12 rounded-tr-sm' 
                    : 'bg-[#282A36] border border-[#50FA7B]/30 mr-12 rounded-tl-sm'
                }`}
              >
                <div className="flex items-center gap-2 mb-2 pb-2 border-b border-white/10">
                  {trace.role === 'user' ? (
                    <User className="w-4 h-4 text-gray-200" />
                  ) : (
                    <Bot className="w-4 h-4 text-[#50FA7B]" />
                  )}
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-300">
                    {trace.role === 'user' ? 'Input / Framework' : 'Agent Response'}
                  </span>
                  <span className="text-[10px] text-gray-400 ml-auto whitespace-nowrap">
                    {new Date(trace.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-sm whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto text-[#F8F8F2]">
                  {trace.content}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default AgentChatDebug;