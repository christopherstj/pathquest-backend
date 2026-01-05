"use client";

import type { ReviewPeak } from "@/lib/db";
import { Skeleton } from "@/components/ui/skeleton";

interface PeakListProps {
    peaks: ReviewPeak[];
    selectedPeakId: string | null;
    onSelectPeak: (peak: ReviewPeak) => void;
    loading?: boolean;
}

function StatusBadge({ peak }: { peak: ReviewPeak }) {
    // Non-snapped peaks show "Flagged" badge
    if (!peak.has_snapped) {
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200/50">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                    <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
                Flagged
            </span>
        );
    }

    // Snapped peaks show distance
    const distance = peak.snapped_distance_m;
    if (distance == null) return <span className="text-muted-foreground">—</span>;

    const getVariant = () => {
        if (distance < 20) return "badge-safe";
        if (distance < 50) return "badge-warning";
        return "badge-danger";
    };

    return (
        <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium ${getVariant()}`}
        >
            {distance.toFixed(0)}m
        </span>
    );
}

export function PeakList({
    peaks,
    selectedPeakId,
    onSelectPeak,
    loading,
}: PeakListProps) {
    if (loading) {
        return (
            <div className="p-3 space-y-2">
                {[...Array(8)].map((_, i) => (
                    <div
                        key={i}
                        className="p-3 rounded-lg animate-fade-in-up"
                        style={{ animationDelay: `${i * 0.05}s`, opacity: 0 }}
                    >
                        <Skeleton className="h-4 w-3/4 mb-2" />
                        <div className="flex justify-between">
                            <Skeleton className="h-3 w-16" />
                            <Skeleton className="h-5 w-12 rounded" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (peaks.length === 0) {
        return (
            <div className="p-8 text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-success/10 flex items-center justify-center">
                    <svg
                        className="w-8 h-8 text-success"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                    >
                        <path d="M20 6 9 17l-5-5" />
                    </svg>
                </div>
                <p className="font-medium text-foreground">All Caught Up!</p>
                <p className="text-sm text-muted-foreground mt-1">
                    No peaks need review
                </p>
            </div>
        );
    }

    return (
        <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
            <div className="p-2 space-y-1">
                {peaks.map((peak, index) => {
                    const isSelected = selectedPeakId === peak.id;
                    return (
                        <button
                            key={peak.id}
                            onClick={() => onSelectPeak(peak)}
                            className={`w-full text-left p-3 rounded-lg transition-all duration-200 animate-fade-in-up ${
                                isSelected
                                    ? "table-row-selected"
                                    : "table-row-hover"
                            }`}
                            style={{
                                animationDelay: `${index * 0.03}s`,
                                opacity: 0,
                            }}
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                    <h3
                                        className={`font-medium text-sm truncate ${
                                            isSelected
                                                ? "text-primary"
                                                : "text-foreground"
                                        }`}
                                    >
                                        {peak.name}
                                    </h3>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-xs text-muted-foreground font-mono">
                                            {peak.snapped_elevation_m?.toFixed(
                                                0
                                            ) ??
                                                peak.elevation?.toFixed(0) ??
                                                "?"}
                                            m
                                        </span>
                                        {(peak.state || peak.country) && (
                                            <>
                                                <span className="text-muted-foreground/50">
                                                    •
                                                </span>
                                                <span className="text-xs text-muted-foreground truncate">
                                                    {[peak.state, peak.country]
                                                        .filter(Boolean)
                                                        .join(", ")}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <StatusBadge peak={peak} />
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
