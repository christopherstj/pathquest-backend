"use client";

import { useState } from "react";
import type { ReviewPeak } from "@/lib/db";
import type { CustomCoords } from "./ReviewMap";
import { Button } from "@/components/ui/button";

interface PeakDetailsProps {
    peak: ReviewPeak | null;
    onAccept: (peakId: string) => void;
    onReject: (peakId: string) => void;
    onDelete: (peakId: string) => void;
    onAcceptCustom: (peakId: string, coords: CustomCoords) => void;
    onSkip: () => void;
    loading?: boolean;
    pickingMode: boolean;
    onTogglePicking: () => void;
    customCoords: CustomCoords | null;
    onClearCustom: () => void;
}

export function PeakDetails({
    peak,
    onAccept,
    onReject,
    onDelete,
    onAcceptCustom,
    onSkip,
    loading,
    pickingMode,
    onTogglePicking,
    customCoords,
    onClearCustom,
}: PeakDetailsProps) {
    const [confirmDelete, setConfirmDelete] = useState(false);

    // Reset confirmation when peak changes
    if (!peak && confirmDelete) {
        setConfirmDelete(false);
    }

    if (!peak) {
        return (
            <div className="glass rounded-xl p-4 flex items-center justify-center gap-3">
                <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center">
                    <svg
                        className="w-5 h-5 text-muted-foreground/50"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                    >
                        <path d="m8 3 4 8 5-5 5 15H2L8 3z" />
                    </svg>
                </div>
                <div>
                    <h3 className="font-semibold text-muted-foreground">
                        Select a Peak
                    </h3>
                    <p className="text-xs text-muted-foreground/70">
                        Choose from the queue to begin review
                    </p>
                </div>
            </div>
        );
    }

    const isSnapped = peak.has_snapped && peak.snapped_lat != null && peak.snapped_lon != null;
    const distanceM = peak.snapped_distance_m ?? 0;
    const elevChange =
        peak.snapped_elevation_m != null && peak.elevation != null
            ? peak.snapped_elevation_m - peak.elevation
            : null;

    return (
        <div className="glass rounded-xl overflow-hidden">
            <div className="p-4">
                {/* Compact header + coords + actions in one row */}
                <div className="flex items-center gap-4">
                    {/* Peak Info */}
                    <div className="min-w-0 flex-shrink-0 w-36">
                        <h2 className="text-base font-semibold tracking-tight truncate">
                            {peak.name}
                        </h2>
                        <p className="text-xs text-muted-foreground truncate">
                            {[peak.state, peak.country].filter(Boolean).join(", ") ||
                                "Unknown"}
                        </p>
                        {!isSnapped && (
                            <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 font-medium">
                                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                                    <line x1="4" y1="22" x2="4" y2="15" />
                                </svg>
                                User flagged
                            </span>
                        )}
                    </div>

                    {/* Compact Coordinates */}
                    <div className="flex gap-2 flex-1 items-center">
                        {/* Current/Seed Location */}
                        <div className={`flex items-center gap-1.5 px-2 py-1.5 rounded ${isSnapped ? "bg-red-50/50 border border-red-200/30" : "bg-amber-50/50 border border-amber-200/30"}`}>
                            <span className={`w-2 h-2 rounded-full ${isSnapped ? "bg-red-500" : "bg-amber-500"} flex-shrink-0`} />
                            <div className="font-mono text-[11px]">
                                <span className="text-muted-foreground">{isSnapped ? "SEED" : "CURRENT"}</span>{" "}
                                <span className="font-medium">{peak.seed_lat.toFixed(5)}, {peak.seed_lon.toFixed(5)}</span>
                                {peak.elevation != null && (
                                    <span className="text-muted-foreground ml-1">
                                        {peak.elevation.toFixed(0)}m
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Arrow + Snapped (only if snapped) */}
                        {isSnapped && (
                            <>
                                <svg className="w-3 h-3 text-muted-foreground flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M5 12h14M12 5l7 7-7 7" />
                                </svg>

                                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-emerald-50/50 border border-emerald-200/30">
                                    <span className="w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-emerald-200 flex-shrink-0" />
                                    <div className="font-mono text-[11px]">
                                        <span className="text-muted-foreground">SNAP</span>{" "}
                                        <span className="font-medium">{peak.snapped_lat!.toFixed(5)}, {peak.snapped_lon!.toFixed(5)}</span>
                                        {peak.snapped_dem_source && (
                                            <span className="ml-1 px-1 py-0.5 rounded text-[9px] bg-emerald-100 text-emerald-700 font-sans font-medium">
                                                {peak.snapped_dem_source.replace("usgs_3dep_", "").replace("m", "m")}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Custom coords (if set) */}
                        {customCoords && (
                            <>
                                <svg className="w-3 h-3 text-purple-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M5 12h14M12 5l7 7-7 7" />
                                </svg>
                                <div className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-purple-50/50 border border-purple-200/30">
                                    <span className="w-2 h-2 rounded-full bg-purple-500 ring-1 ring-purple-200 flex-shrink-0" />
                                    <div className="font-mono text-[11px]">
                                        <span className="text-purple-600">CUSTOM</span>{" "}
                                        <span className="font-medium">{customCoords.lat.toFixed(5)}, {customCoords.lon.toFixed(5)}</span>
                                    </div>
                                    <button
                                        onClick={onClearCustom}
                                        className="ml-1 text-purple-400 hover:text-purple-600"
                                        title="Clear custom"
                                    >
                                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M18 6 6 18M6 6l12 12" />
                                        </svg>
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Distance + Elevation Change (only for snapped peaks) */}
                    {isSnapped && (
                        <div className="flex items-center gap-3 flex-shrink-0">
                            <div className="text-center">
                                <div
                                    className={`text-lg font-bold tabular-nums ${
                                        distanceM < 20
                                            ? "text-primary"
                                            : distanceM < 50
                                              ? "text-secondary"
                                              : "text-destructive"
                                    }`}
                                >
                                    {distanceM.toFixed(1)}m
                                </div>
                                <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
                                    Moved
                                </div>
                            </div>

                            {elevChange != null && (
                                <div className="text-center">
                                    <div
                                        className={`text-lg font-bold tabular-nums flex items-center justify-center gap-0.5 ${
                                            elevChange > 0 ? "text-emerald-600" : "text-red-600"
                                        }`}
                                    >
                                        <svg
                                            className="w-3 h-3"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.5"
                                        >
                                            {elevChange > 0 ? (
                                                <path d="m18 15-6-6-6 6" />
                                            ) : (
                                                <path d="m6 9 6 6 6-6" />
                                            )}
                                        </svg>
                                        {Math.abs(elevChange).toFixed(0)}m
                                    </div>
                                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
                                        Elev
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Divider */}
                    <div className="h-8 w-px bg-border flex-shrink-0" />

                    {/* Action Buttons - Compact */}
                    <div className="flex gap-1.5 flex-shrink-0">
                        {/* Main actions */}
                        {customCoords ? (
                            <button
                                onClick={() => onAcceptCustom(peak.id, customCoords)}
                                disabled={loading}
                                className="bg-gradient-to-b from-purple-500 to-purple-600 text-white font-medium py-1.5 px-3 rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-sm shadow-sm"
                            >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M20 6 9 17l-5-5" />
                                </svg>
                                Accept Custom
                            </button>
                        ) : isSnapped ? (
                            <button
                                onClick={() => onAccept(peak.id)}
                                disabled={loading}
                                className="btn-accept text-white font-medium py-1.5 px-3 rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-sm"
                            >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M20 6 9 17l-5-5" />
                                </svg>
                                Accept
                            </button>
                        ) : (
                            <button
                                onClick={() => onAccept(peak.id)}
                                disabled={loading}
                                className="bg-gradient-to-b from-slate-400 to-slate-500 text-white font-medium py-1.5 px-3 rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-sm shadow-sm"
                                title="Mark as reviewed (coordinates OK)"
                            >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M20 6 9 17l-5-5" />
                                </svg>
                                Dismiss
                            </button>
                        )}
                        {/* Only show Reject for snapped peaks */}
                        {isSnapped && (
                            <button
                                onClick={() => onReject(peak.id)}
                                disabled={loading}
                                className="btn-reject text-white font-medium py-1.5 px-3 rounded-lg transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-sm"
                            >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M18 6 6 18M6 6l12 12" />
                                </svg>
                                Reject
                            </button>
                        )}

                        {/* Pick Custom button */}
                        <Button
                            variant={pickingMode ? "default" : "outline"}
                            onClick={onTogglePicking}
                            disabled={loading}
                            className={`h-auto py-1.5 px-2 text-sm ${pickingMode ? "bg-purple-600 hover:bg-purple-700" : ""}`}
                            title="Pick custom location on map"
                        >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="8" x2="12" y2="16" />
                                <line x1="8" y1="12" x2="16" y2="12" />
                            </svg>
                        </Button>

                        <Button
                            variant="outline"
                            onClick={onSkip}
                            disabled={loading}
                            className="h-auto py-1.5 text-sm"
                        >
                            Skip
                        </Button>
                        
                        {/* Delete button - icon only */}
                        {!confirmDelete ? (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmDelete(true)}
                                disabled={loading}
                                className="h-auto py-1.5 px-1.5 text-muted-foreground hover:text-destructive"
                                title="Delete peak"
                            >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                </svg>
                            </Button>
                        ) : (
                            <div className="flex items-center gap-1">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setConfirmDelete(false)}
                                    disabled={loading}
                                    className="h-auto py-1.5 px-1.5"
                                >
                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M18 6 6 18M6 6l12 12" />
                                    </svg>
                                </Button>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => {
                                        onDelete(peak.id);
                                        setConfirmDelete(false);
                                    }}
                                    disabled={loading}
                                    className="h-auto py-1.5 px-2 text-sm"
                                >
                                    Delete
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
