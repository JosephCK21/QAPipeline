import React, { useEffect, useRef, useMemo, useState } from 'react';
import { useAppContext } from '../App';
import { Bot, User, Activity, Trash2, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

const CALLER_LABELS = {
    generateTestCasesForScenario:    'Generate Test Cases',
    repairTestCaseScript:            'Heal Test Script',
    generateTestScenarios:           'Generate Scenarios (Story)',
    generateTestScenariosForEpic:    'Generate Scenarios (Epic)',
    mapPrChangesToScenarios:         'PR → Scenario Mapping',
    generateScenariosFromJiraContext:'Jira Scenario Generation',
};

function callerLabel(caller) {
    return CALLER_LABELS[caller] || caller;
}

function formatDuration(ms) {
    if (ms == null) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Pair request + response traces that share the same caller, grouped in arrival order.
 * A request without a response yet renders a "pending" state.
 */
function pairTraces(traces) {
    const pairs = [];
    const pendingByKey = new Map(); // key → index in pairs

    for (const trace of traces) {
        const key = `${trace.caller}`;
        if (trace.phase === 'request') {
            const idx = pairs.length;
            pairs.push({ request: trace, response: null });
            pendingByKey.set(key, idx);
        } else if (trace.phase === 'response') {
            const idx = pendingByKey.get(key);
            if (idx != null && pairs[idx].response == null) {
                pairs[idx] = { ...pairs[idx], response: trace };
                pendingByKey.delete(key);
            } else {
                pairs.push({ request: null, response: trace });
            }
        }
    }
    return pairs;
}

// Lines above this threshold get the collapse toggle
const COLLAPSE_THRESHOLD = 30;

function ExpandableText({ text, colorClass = 'text-[#5E6C84]' }) {
    const [expanded, setExpanded] = useState(false);
    const lines = (text || '').split('\n');
    const isLong = lines.length > COLLAPSE_THRESHOLD;
    const displayed = isLong && !expanded ? lines.slice(0, COLLAPSE_THRESHOLD).join('\n') : text;

    return (
        <div>
            <pre className={`text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto ${colorClass}`}>
                {displayed}
                {isLong && !expanded && <span className="text-[#8993A4]"> …</span>}
            </pre>
            {isLong && (
                <button
                    onClick={() => setExpanded(e => !e)}
                    className="mt-2 flex items-center gap-1 text-[10px] text-[#0C66E4] hover:text-[#172B4D] transition-colors"
                >
                    {expanded
                        ? <><ChevronUp className="w-3 h-3" /> Collapse</>
                        : <><ChevronDown className="w-3 h-3" /> Show full text ({lines.length} lines)</>
                    }
                </button>
            )}
        </div>
    );
}

function RequestBubble({ trace }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[80%] ml-12 rounded-2xl rounded-tr-sm bg-[#DEEBFF] border border-[#0C66E4]/20 shadow-md">
                <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-white/10">
                    <User className="w-3.5 h-3.5 text-[#0C66E4]" />
                    <span className="text-xs font-bold uppercase tracking-wider text-[#0C66E4]">
                        {callerLabel(trace.caller)}
                    </span>
                    <span className="ml-auto text-[10px] text-[#5E6C84] whitespace-nowrap">
                        {new Date(trace.timestamp).toLocaleTimeString()}
                    </span>
                </div>
                <div className="px-4 py-3 overflow-x-auto">
                    <ExpandableText text={trace.prompt || '(no prompt captured)'} colorClass="text-[#5E6C84]" />
                </div>
                <div className="px-4 pb-2 text-[10px] text-[#8993A4]">
                    model: <span className="text-[#5E6C84]">{trace.model}</span>
                </div>
            </div>
        </div>
    );
}

function ResponseBubble({ trace, pending }) {
    return (
        <div className="flex justify-start">
            <div className={`max-w-[80%] mr-12 rounded-2xl rounded-tl-sm shadow-md border ${
                pending
                    ? 'bg-[#DFE1E6] border-[#5E6C84]/40'
                    : 'bg-[#E3FCEF] border-[#00875A]/30'
            }`}>
                <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-white/10">
                    {pending
                        ? <Loader2 className="w-3.5 h-3.5 text-[#B65C00] animate-spin" />
                        : <Bot className="w-3.5 h-3.5 text-[#00875A]" />
                    }
                    <span className={`text-xs font-bold uppercase tracking-wider ${pending ? 'text-[#B65C00]' : 'text-[#00875A]'}`}>
                        {pending ? 'Waiting for response…' : 'LLM Response'}
                    </span>
                    {trace && (
                        <span className="ml-auto text-[10px] text-[#5E6C84] whitespace-nowrap">
                            {new Date(trace.timestamp).toLocaleTimeString()}
                        </span>
                    )}
                </div>
                {!pending && trace && (
                    <>
                        {trace.reasoningSummary && (
                            <div className="mx-4 mt-3 rounded-lg border border-[#5E4DB2]/30 bg-[#EAE6FF]">
                                <div className="flex items-center gap-2 px-3 pt-2 pb-1 border-b border-[#5E4DB2]/20">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#5E4DB2]">
                                        reasoning summary
                                    </span>
                                </div>
                                <div className="px-3 py-2">
                                    <ExpandableText text={trace.reasoningSummary} colorClass="text-[#5E4DB2]" />
                                </div>
                            </div>
                        )}
                        <div className="px-4 py-3 overflow-x-auto">
                            <ExpandableText text={trace.response || '(empty response)'} colorClass="text-[#172B4D]" />
                        </div>
                        <div className="px-4 pb-2 flex flex-wrap gap-4 text-[10px] text-[#8993A4]">
                            {trace.durationMs != null && (
                                <span>duration: <span className="text-[#B65C00]">{formatDuration(trace.durationMs)}</span></span>
                            )}
                            {trace.conversationId && (
                                <span>conversation: <span className="text-[#0C66E4]">{trace.conversationId}</span></span>
                            )}
                            {trace.responseId && (
                                <span>response: <span className="text-[#00875A]">{trace.responseId}</span></span>
                            )}
                            {trace.usage && typeof trace.usage.inputTokens === 'number' && (
                                <span>
                                    tokens: <span className="text-[#172B4D]">{trace.usage.inputTokens} in / {trace.usage.outputTokens} out</span>
                                    {trace.usage.cachedTokens > 0 && trace.usage.inputTokens > 0 && (
                                        <span className="ml-1 text-[#00875A]">
                                            (cached {trace.usage.cachedTokens}, {Math.round((trace.usage.cachedTokens / trace.usage.inputTokens) * 100)}%)
                                        </span>
                                    )}
                                    {trace.usage.reasoningTokens > 0 && (
                                        <span className="ml-1 text-[#5E4DB2]">· reasoning {trace.usage.reasoningTokens}</span>
                                    )}
                                </span>
                            )}
                            {trace.error && (
                                <span className="text-[#C9372C]">error: {trace.error}</span>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function AgentChatDebug() {
    const { llmTraces, setLlmTraces } = useAppContext();
    const bottomRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [llmTraces]);

    const pairs = useMemo(() => pairTraces(llmTraces), [llmTraces]);

    const handleClear = () => setLlmTraces([]);

    return (
        <div className="flex flex-col h-full space-y-4 animate-fade-in">
            {/* Header */}
            <div className="flex justify-between items-center bg-[#FFFFFF] p-4 rounded-xl border border-[#DFE1E6]">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-[#172B4D] flex items-center gap-2">
                        <Activity className="w-4 h-4 text-[#B65C00]" />
                        Agent Console
                    </h1>
                    <p className="text-xs text-[#5E6C84] mt-1">
                        Global real-time log of all system LLM calls &mdash; prompts on the right, responses on the left
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-xs text-[#8993A4]">{llmTraces.length} trace{llmTraces.length !== 1 ? 's' : ''}</span>
                    <button
                        onClick={handleClear}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[#DFE1E6] hover:bg-[#C9372C]/20 border border-[#5E6C84]/40 hover:border-[#C9372C]/50 text-[#5E6C84] hover:text-[#C9372C] transition-colors"
                    >
                        <Trash2 className="w-3 h-3" /> Clear
                    </button>
                </div>
            </div>

            {/* Trace log */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                {pairs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center p-16 bg-white rounded-xl border border-[#DFE1E6]">
                        <Bot className="w-12 h-12 text-[#5E6C84] mb-4 opacity-40" />
                        <p className="text-lg font-medium text-[#8993A4]">No LLM calls yet</p>
                        <p className="text-[#8993A4] mt-2 text-center text-sm">
                            Trigger a pipeline or generate scenarios to see live LLM traces here.
                        </p>
                    </div>
                ) : (
                    pairs.map((pair, i) => (
                        <div key={i} className="space-y-2">
                            {pair.request && <RequestBubble trace={pair.request} />}
                            <ResponseBubble trace={pair.response} pending={!pair.response} />
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>
        </div>
    );
}

export default AgentChatDebug;
