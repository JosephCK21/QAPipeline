import React, { useEffect, useState } from 'react';
import { Check, Loader2, Clock, AlertCircle, Ban } from 'lucide-react';

function ExecutionStepper({ phases, animated = false }) {
  const [animatedPhases, setAnimatedPhases] = useState(phases);

  useEffect(() => {
    setAnimatedPhases(phases);
  }, [phases]);

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed':
        return <Check className="w-5 h-5 text-[#172B4D]" />;
      case 'running':
        return <Loader2 className="w-5 h-5 text-[#172B4D] animate-spin" />;
      case 'pending':
        return <Clock className="w-5 h-5 text-[#5E6C84]" />;
      case 'failed':
        return <AlertCircle className="w-5 h-5 text-[#172B4D]" />;
      case 'blocked':
        return <Ban className="w-5 h-5 text-[#172B4D]" />;
      default:
        return <Clock className="w-5 h-5 text-[#5E6C84]" />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed':
        return 'bg-[#00875A]';
      case 'running':
        return 'bg-[#0C66E4]';
      case 'pending':
        return 'bg-[#DFE1E6] border-2 border-[#5E6C84]';
      case 'failed':
        return 'bg-[#C9372C]';
      case 'blocked':
        return 'bg-[#B65C00]';
      default:
        return 'bg-[#DFE1E6] border-2 border-[#5E6C84]';
    }
  };

  const getLineColor = (status) => {
    switch (status) {
      case 'completed':
        return 'bg-[#00875A]';
      case 'running':
        return 'bg-gradient-to-r from-[#00875A] to-[#0C66E4]';
      case 'failed':
        return 'bg-[#C9372C]';
      default:
        return 'bg-[#DFE1E6]';
    }
  };

  return (
    <div className="w-full">
      <div className="flex items-center justify-between relative">
        {/* Connection Lines */}
        <div className="absolute top-6 left-0 right-0 h-1 flex z-0 px-[10%]">
          {animatedPhases.slice(0, -1).map((phase, index) => (
            <div 
              key={index} 
              className={`flex-1 ${getLineColor(phase.status)} transition-all duration-500`}
            />
          ))}
        </div>

        {/* Phase Steps */}
        {animatedPhases.map((phase, index) => (
          <div key={index} className="flex flex-col items-center z-10 flex-1">
            {/* Circle */}
            <div 
              className={`w-12 h-12 rounded-full flex items-center justify-center ${getStatusColor(phase.status)} transition-all duration-300 shadow-lg ${
                phase.status === 'running' ? 'ring-4 ring-[#0C66E4]/30' : ''
              }`}
            >
              {getStatusIcon(phase.status)}
            </div>
            
            {/* Label */}
            <div className="mt-3 text-center">
              <p className={`text-sm font-medium ${
                phase.status === 'completed' ? 'text-[#00875A]' :
                phase.status === 'running' ? 'text-[#0C66E4]' :
                phase.status === 'failed' ? 'text-[#C9372C]' :
                phase.status === 'blocked' ? 'text-[#B65C00]' :
                'text-[#5E6C84]'
              }`}>
                {phase.name}
              </p>
              <p className="text-xs text-[#5E6C84] mt-1">
                {phase.duration !== '-' ? phase.duration : 
                  phase.status === 'running' ? 'In Progress...' : 'Waiting...'}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ExecutionStepper;