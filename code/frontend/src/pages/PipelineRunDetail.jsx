import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAppContext } from '../App';
import ExecutionStepper from '../components/ExecutionStepper';
import DetailTabs from '../components/DetailTabs';
import { 
  ArrowLeft, 
  User, 
  Clock, 
  GitBranch,
  TestTube,
  CheckCircle,
  RefreshCw,
  Sparkles,
  Loader
} from 'lucide-react';

function PipelineRunDetail() {
  const { id } = useParams();
  const { setSelectedRun, refreshKey } = useAppContext();
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRun = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/runs');
        if (res.ok) {
          const runsData = await res.json();
          // Find run by id, mapping from the backend 'runId'
          const found = runsData.find(r => r.runId === id || r.id === id);
          if (found) {
            
            // Extract RTM from events if present
            const rtmEvent = (found.events || []).find(e => e.type === 'rtm_generated');
            const rtmData = rtmEvent ? rtmEvent.data.rtm : [];

            // Map backend data to frontend UI expectations
            const mappedRun = {
              id: found.runId,
              title: found.prDetails?.title || 'Triggered Pipeline',
              status: found.status,
              author: found.prDetails?.author || 'Unknown',
              timestamp: found.createdAt || new Date().toISOString(),
              branch: found.prDetails?.headBranch || found.repository?.default_branch || 'main',
              metrics: found.metrics || {
                testsGenerated: 0,
                testsPassed: 0,
                healingAttempts: 0,
                healingSuccess: 0
              },
              phases: found.phases || [],
              events: found.events || [],
              rtm: rtmData
            };

            setRun(mappedRun);
            setSelectedRun(mappedRun);
          }
        }
      } catch (error) {
        console.error('Failed to fetch run:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchRun();
  }, [id, refreshKey, setSelectedRun]);

  useEffect(() => {
    return () => setSelectedRun(null);
  }, [setSelectedRun]);

  if (loading) {
     return (
        <div className="flex flex-col items-center justify-center h-96">
            <Loader className="w-8 h-8 text-[#5E6C84] animate-spin mb-4" />
            <p className="text-[#5E6C84]">Loading pipeline data...</p>
        </div>
     );
  }

  if (!run) {
    return (
      <div className="flex flex-col items-center justify-center h-96">
        <p className="text-[#5E6C84] text-lg mb-4">Pipeline run not found</p>
        <Link 
          to="/" 
          className="flex items-center gap-2 text-[#0C66E4] hover:text-[#172B4D] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'Completed': return 'text-[#00875A]';
      case 'Running': return 'text-[#0C66E4]';
      case 'Failed': return 'text-[#C9372C]';
      default: return 'text-[#5E6C84]';
    }
  };

  const getStatusBg = (status) => {
    switch (status) {
      case 'Completed': return 'bg-[#00875A]/20';
      case 'Running': return 'bg-[#0C66E4]/20';
      case 'Failed': return 'bg-[#C9372C]/20';
      default: return 'bg-[#5E6C84]/20';
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Back Navigation */}
      <Link 
        to="/" 
        className="inline-flex items-center gap-2 text-[#5E6C84] hover:text-[#172B4D] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      {/* Header */}
      <div className="bg-[#FFFFFF] rounded-xl border border-[#DFE1E6] p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-[#172B4D]">
                PR #{run.id}: {run.title}
              </h1>
              <span className={`px-3 py-1 text-sm font-medium rounded-full ${getStatusBg(run.status)} ${getStatusColor(run.status)}`}>
                {run.status}
              </span>
            </div>
            <div className="flex items-center gap-6 text-sm text-[#5E6C84]">
              <span className="flex items-center gap-2">
                <User className="w-4 h-4" />
                {run.author}
              </span>
              <span className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                {new Date(run.timestamp).toLocaleString()}
              </span>
              <span className="flex items-center gap-2">
                <GitBranch className="w-4 h-4" />
                <code className="px-2 py-0.5 bg-[#DFE1E6] rounded">{run.branch}</code>
              </span>
            </div>
          </div>
        </div>

        {/* Metrics Summary */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="bg-[#DFE1E6] rounded-lg p-4">
            <div className="flex items-center gap-2 text-[#5E6C84] mb-1">
              <TestTube className="w-4 h-4" />
              <span className="text-xs font-medium">Tests Generated</span>
            </div>
            <p className="text-2xl font-bold text-[#172B4D]">{run.metrics.testsGenerated}</p>
          </div>
          <div className="bg-[#DFE1E6] rounded-lg p-4">
            <div className="flex items-center gap-2 text-[#5E6C84] mb-1">
              <CheckCircle className="w-4 h-4" />
              <span className="text-xs font-medium">Tests Passed</span>
            </div>
            <p className="text-2xl font-bold text-[#00875A]">{run.metrics.testsPassed}</p>
          </div>
          <div className="bg-[#DFE1E6] rounded-lg p-4">
            <div className="flex items-center gap-2 text-[#5E6C84] mb-1">
              <RefreshCw className="w-4 h-4" />
              <span className="text-xs font-medium">Healing Attempts</span>
            </div>
            <p className="text-2xl font-bold text-[#B65C00]">{run.metrics.healingAttempts}</p>
          </div>
          <div className="bg-[#DFE1E6] rounded-lg p-4">
            <div className="flex items-center gap-2 text-[#5E6C84] mb-1">
              <Sparkles className="w-4 h-4" />
              <span className="text-xs font-medium">Healing Success</span>
            </div>
            <p className="text-2xl font-bold text-[#0C66E4]">{run.metrics.healingSuccess}</p>
          </div>
        </div>

        {/* 5-Phase Execution Flow */}
        <div>
          <h3 className="text-sm font-medium text-[#5E6C84] mb-4">Execution Flow</h3>
          <ExecutionStepper phases={run.phases} animated />
        </div>
      </div>

      {/* Detail Tabs */}
      <DetailTabs run={run} />
    </div>
  );
}

export default PipelineRunDetail;