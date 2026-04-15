import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

function MetricCard({ title, value, subtitle, icon: Icon, trend, trendValue, color = 'blue' }) {
  const colorClasses = {
    blue: 'from-[#6272A4] to-[#8BE9FD]',
    green: 'from-[#50FA7B] to-[#69FF94]',
    red: 'from-[#FF5555] to-[#FF6E6E]',
    orange: 'from-[#FFB86C] to-[#FFCB8C]',
    purple: 'from-[#BD93F9] to-[#D4AFFF]'
  };

  const getTrendIcon = () => {
    if (trend === 'up') return <TrendingUp className="w-4 h-4 text-[#50FA7B]" />;
    if (trend === 'down') return <TrendingDown className="w-4 h-4 text-[#FF5555]" />;
    return <Minus className="w-4 h-4 text-[#6272A4]" />;
  };

  return (
    <div className="bg-[#1E1E2F] rounded-xl border border-[#282A36] p-6 hover:border-[#6272A4]/50 transition-all duration-300 group">
      <div className="flex items-start justify-between mb-4">
        <div className={`w-12 h-12 rounded-lg bg-gradient-to-br ${colorClasses[color]} flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform duration-300`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
        {trend && (
          <div className="flex items-center gap-1 text-sm">
            {getTrendIcon()}
            <span className={`${
              trend === 'up' ? 'text-[#50FA7B]' : 
              trend === 'down' ? 'text-[#FF5555]' : 'text-[#6272A4]'
            }`}>
              {trendValue}
            </span>
          </div>
        )}
      </div>
      
      <h3 className="text-[#6272A4] text-sm font-medium mb-1">{title}</h3>
      <p className="text-3xl font-bold text-[#F8F8F2] mb-1">{value}</p>
      {subtitle && (
        <p className="text-xs text-[#6272A4]">{subtitle}</p>
      )}
    </div>
  );
}

export default MetricCard;