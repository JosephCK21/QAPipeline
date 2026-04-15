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
        return <Check className="w-5 h-5 text-white" />;
      case 'running':
        return <Loader2 className="w-5 h-5 text-white animate-spin" />;
      case 'pending':
        return <Clock className="w-5 h-5 text-[#6272A4]" />;
      case 'failed':
        return <AlertCircle className="w-5 h-5 text-white" />;
      case 'blocked':
        return <Ban className="w-5 h-5 text-white" />;
      default:
        return <Clock className="w-5 h-5 text-[#6272A4]" />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed':
        return 'bg-[#50FA7B]';
      case 'running':
        return 'bg-[#8BE9FD]';
      case 'pending':
        return 'bg-[#282A36] border-2 border-[#6272A4]';
      case 'failed':
        return 'bg-[#FF5555]';
      case 'blocked':
        return 'bg-[#FFB86C]';
      default:
        return 'bg-[#282A36] border-2 border-[#6272A4]';
    }
  };

  const getLineColor = (status) => {
    switch (status) {
      case 'completed':
        return 'bg-[#50FA7B]';
      case 'running':
        return 'bg-gradient-to-r from-[#50FA7B] to-[#8BE9FD]';
      case 'failed':
        return 'bg-[#FF5555]';
      default:
        return 'bg-[#282A36]';
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
                phase.status === 'running' ? 'ring-4 ring-[#8BE9FD]/30' : ''
              }`}
            >
              {getStatusIcon(phase.status)}
            </div>
            
            {/* Label */}
            <div className="mt-3 text-center">
              <p className={`text-sm font-medium ${
                phase.status === 'completed' ? 'text-[#50FA7B]' :
                phase.status === 'running' ? 'text-[#8BE9FD]' :
                phase.status === 'failed' ? 'text-[#FF5555]' :
                phase.status === 'blocked' ? 'text-[#FFB86C]' :
                'text-[#6272A4]'
              }`}>
                {phase.name}
              </p>
              <p className="text-xs text-[#6272A4] mt-1">
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