import { Sparkles } from 'lucide-react';

interface AiAssistedBadgeProps {
    percent?: number;
}

export function formatAiAssistedPercent(percent: number | undefined): string | undefined {
    if (percent === undefined || !Number.isInteger(percent) || percent < 0 || percent > 100) {
        return undefined;
    }

    return `${percent}% est.`;
}

export function AiAssistedBadge({ percent }: AiAssistedBadgeProps) {
    const percentLabel = formatAiAssistedPercent(percent);

    return (
        <span className="ai-assisted-badge">
            <Sparkles aria-hidden="true" />
            <span>AI-assisted</span>
            {percentLabel ? <span className="ai-assisted-badge__percent">{percentLabel}</span> : null}
        </span>
    );
}
