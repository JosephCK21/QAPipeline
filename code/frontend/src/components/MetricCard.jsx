import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

function MetricCard({ title, value, subtitle, icon: Icon, trend, trendValue, color = 'blue' }) {
  const colorClasses = {
    blue: 'from-[#0C66E4] to-[#0747A6]',
    green: 'from-[#00875A] to-[#69FF94]',
    red: 'from-[#C9372C] to-[#FF6E6E]',
    orange: 'from-[#B65C00] to-[#FFCB8C]',
    purple: 'from-[#5E4DB2] to-[#D4AFFF]'
  };

  const getTrendIcon = () => {
    if (trend === 'up') return <TrendingUp className="w-4 h-4 text-[#00875A]" />;
    if (trend === 'down') return <TrendingDown className="w-4 h-4 text-[#C9372C]" />;
    return <Minus className="w-4 h-4 text-[#5E6C84]" />;
  };

  return (
    <div className="bg-white rounded-lg border border-[#DFE1E6] p-5 shadow-[0_1px_2px_rgba(9,30,66,0.08)] hover:shadow-[0_4px_12px_-2px_rgba(9,30,66,0.12)] hover:border-[#0C66E4]/40 transition-all duration-200 group">
      <div className="flex items-start justify-between mb-4">
        <div className={`w-11 h-11 rounded-md bg-gradient-to-br ${colorClasses[color]} flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform duration-200`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        {trend && (
          <div className="flex items-center gap-1 text-sm">
            {getTrendIcon()}
            <span className={`${
              trend === 'up' ? 'text-[#00875A]' : 
              trend === 'down' ? 'text-[#C9372C]' : 'text-[#5E6C84]'
            }`}>
              {trendValue}
            </span>
          </div>
        )}
      </div>
      
      <h3 className="text-[#5E6C84] text-sm font-medium mb-1">{title}</h3>
      <p className="text-3xl font-bold text-[#172B4D] mb-1">{value}</p>
      {subtitle && (
        <p className="text-xs text-[#5E6C84]">{subtitle}</p>
      )}
    </div>
  );
}

export default MetricCard;