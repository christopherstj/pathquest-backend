"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReviewPeak } from "@/lib/db";
import { ReviewMap, CustomCoords } from "@/components/ReviewMap";
import { PeakList } from "@/components/PeakList";
import { PeakDetails } from "@/components/PeakDetails";
import { Button } from "@/components/ui/button";

export default function ReviewPage() {
    const [peaks, setPeaks] = useState<ReviewPeak[]>([]);
    const [selectedPeak, setSelectedPeak] = useState<ReviewPeak | null>(null);
    const [loading, setLoading] = useState(true);
    const [updating, setUpdating] = useState(false);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [pickingMode, setPickingMode] = useState(false);
    const [customCoords, setCustomCoords] = useState<CustomCoords | null>(null);
    const limit = 50;

    const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

    const fetchPeaks = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(
                `/api/peaks/review?limit=${limit}&offset=${offset}`
            );
            const data = await res.json();
            setPeaks(data.peaks ?? []);
            setTotal(data.total ?? 0);
            if (data.peaks?.length > 0 && !selectedPeak) {
                setSelectedPeak(data.peaks[0]);
            }
        } catch (error) {
            console.error("Failed to fetch peaks:", error);
        } finally {
            setLoading(false);
        }
    }, [offset, selectedPeak]);

    useEffect(() => {
        fetchPeaks();
    }, [fetchPeaks]);

    // Clear custom coords when peak changes
    useEffect(() => {
        setCustomCoords(null);
        setPickingMode(false);
    }, [selectedPeak?.id]);

    const removePeakFromList = (peakId: string) => {
        const currentIndex = peaks.findIndex((p) => p.id === peakId);
        const newPeaks = peaks.filter((p) => p.id !== peakId);
        setPeaks(newPeaks);
        setTotal((t) => Math.max(0, t - 1));
        setCustomCoords(null);
        setPickingMode(false);

        if (newPeaks.length > 0) {
            const nextIndex = Math.min(currentIndex, newPeaks.length - 1);
            setSelectedPeak(newPeaks[nextIndex]);
        } else {
            setSelectedPeak(null);
            if (total > limit) fetchPeaks();
        }
    };

    const handleAction = async (peakId: string, action: "accept" | "reject") => {
        setUpdating(true);
        try {
            const res = await fetch("/api/peaks/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ peakId, action }),
            });

            if (!res.ok) throw new Error("Failed to update peak");
            removePeakFromList(peakId);
        } catch (error) {
            console.error("Failed to update peak:", error);
        } finally {
            setUpdating(false);
        }
    };

    const handleAcceptCustom = async (peakId: string, coords: CustomCoords) => {
        setUpdating(true);
        try {
            const res = await fetch("/api/peaks/accept-custom", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ peakId, lat: coords.lat, lon: coords.lon }),
            });

            if (!res.ok) throw new Error("Failed to update peak");
            removePeakFromList(peakId);
        } catch (error) {
            console.error("Failed to accept custom coords:", error);
        } finally {
            setUpdating(false);
        }
    };

    const handleSkip = () => {
        if (!selectedPeak) return;
        const currentIndex = peaks.findIndex((p) => p.id === selectedPeak.id);
        const nextIndex = (currentIndex + 1) % peaks.length;
        setSelectedPeak(peaks[nextIndex]);
    };

    const handleDelete = async (peakId: string) => {
        setUpdating(true);
        try {
            const res = await fetch("/api/peaks/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ peakId }),
            });

            if (!res.ok) throw new Error("Failed to delete peak");
            removePeakFromList(peakId);
        } catch (error) {
            console.error("Failed to delete peak:", error);
        } finally {
            setUpdating(false);
        }
    };

    const handlePick = (coords: CustomCoords) => {
        setCustomCoords(coords);
        setPickingMode(false); // Turn off picking mode after placing
    };

    return (
        <div className="min-h-screen">
            {/* Header */}
            <header className="glass sticky top-0 z-50 border-b">
                <div className="max-w-[1800px] mx-auto px-6 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            {/* Logo mark */}
                            <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                                <svg
                                    className="w-6 h-6 text-primary"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="m8 3 4 8 5-5 5 15H2L8 3z" />
                                </svg>
                            </div>
                            <div>
                                <h1 className="text-xl font-semibold tracking-tight">
                                    Coordinate Review
                                </h1>
                                <p className="text-sm text-muted-foreground font-mono">
                                    PathQuest Peak Verification
                                </p>
                            </div>
                        </div>

                        {/* Stats badge */}
                        <div className="flex items-center gap-6">
                            <div className="text-right">
                                <div className="text-2xl font-semibold tabular-nums text-primary">
                                    {total.toLocaleString()}
                                </div>
                                <div className="text-xs text-muted-foreground uppercase tracking-wider">
                                    Peaks to Review
                                </div>
                            </div>
                            <div className="h-10 w-px bg-border" />
                            <div className="text-right">
                                <div className="text-2xl font-semibold tabular-nums text-secondary">
                                    {peaks.length > 0
                                        ? Math.round(
                                              peaks.reduce(
                                                  (acc, p) =>
                                                      acc +
                                                      (p.snapped_distance_m ?? 0),
                                                  0
                                              ) / peaks.length
                                          )
                                        : 0}
                                    m
                                </div>
                                <div className="text-xs text-muted-foreground uppercase tracking-wider">
                                    Avg Distance
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-[1800px] mx-auto px-6 py-6">
                <div className="grid grid-cols-12 gap-6">
                    {/* Left Panel: Peak List */}
                    <div className="col-span-12 lg:col-span-4 xl:col-span-3">
                        <div className="glass rounded-xl overflow-hidden animate-fade-in-up">
                            {/* List Header */}
                            <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
                                <div>
                                    <h2 className="font-semibold text-sm">
                                        Queue
                                    </h2>
                                    <p className="text-xs text-muted-foreground">
                                        {offset + 1}–
                                        {Math.min(offset + peaks.length, total)}{" "}
                                        of {total}
                                    </p>
                                </div>
                                <div className="flex gap-1">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            setOffset((o) =>
                                                Math.max(0, o - limit)
                                            )
                                        }
                                        disabled={offset === 0}
                                        className="h-8 w-8 p-0"
                                    >
                                        <svg
                                            className="w-4 h-4"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <path d="m15 18-6-6 6-6" />
                                        </svg>
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            setOffset((o) => o + limit)
                                        }
                                        disabled={offset + limit >= total}
                                        className="h-8 w-8 p-0"
                                    >
                                        <svg
                                            className="w-4 h-4"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                        >
                                            <path d="m9 18 6-6-6-6" />
                                        </svg>
                                    </Button>
                                </div>
                            </div>

                            <PeakList
                                peaks={peaks}
                                selectedPeakId={selectedPeak?.id ?? null}
                                onSelectPeak={setSelectedPeak}
                                loading={loading}
                            />
                        </div>
                    </div>

                    {/* Right Panel: Map + Details */}
                    <div className="col-span-12 lg:col-span-8 xl:col-span-9 space-y-4">
                        {/* Peak Details Card */}
                        <div
                            className="animate-fade-in-up stagger-1"
                            style={{ opacity: 0 }}
                        >
                            <PeakDetails
                                peak={selectedPeak}
                                onAccept={(id) => handleAction(id, "accept")}
                                onReject={(id) => handleAction(id, "reject")}
                                onDelete={handleDelete}
                                onAcceptCustom={handleAcceptCustom}
                                onSkip={handleSkip}
                                loading={updating}
                                pickingMode={pickingMode}
                                onTogglePicking={() => setPickingMode(!pickingMode)}
                                customCoords={customCoords}
                                onClearCustom={() => setCustomCoords(null)}
                            />
                        </div>

                        {/* Map */}
                        <div
                            className="animate-fade-in-up stagger-2"
                            style={{ opacity: 0 }}
                        >
                            <div className="map-container rounded-xl h-[500px]">
                                {mapboxToken ? (
                                    <ReviewMap
                                        peak={selectedPeak}
                                        mapboxToken={mapboxToken}
                                        pickingMode={pickingMode}
                                        customCoords={customCoords}
                                        onPick={handlePick}
                                    />
                                ) : (
                                    <div className="flex items-center justify-center h-full bg-muted/50">
                                        <div className="text-center">
                                            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
                                                <svg
                                                    className="w-8 h-8 text-muted-foreground"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="1.5"
                                                >
                                                    <path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7" />
                                                </svg>
                                            </div>
                                            <p className="text-muted-foreground font-medium">
                                                Map Unavailable
                                            </p>
                                            <p className="text-sm text-muted-foreground/70 mt-1">
                                                Set NEXT_PUBLIC_MAPBOX_TOKEN
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Legend */}
                        <div
                            className="flex items-center justify-center gap-6 text-sm text-muted-foreground animate-fade-in-up stagger-3"
                            style={{ opacity: 0 }}
                        >
                            <div className="flex items-center gap-2">
                                <span className="w-3 h-3 rounded-full bg-red-500 border-2 border-white shadow-sm" />
                                <span className="font-mono text-xs">
                                    Seed (Original)
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-white shadow-sm" />
                                <span className="font-mono text-xs">
                                    Snapped (Proposed)
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-3.5 h-3.5 rounded-full bg-purple-500 border-2 border-white shadow-sm" />
                                <span className="font-mono text-xs">
                                    Custom (Manual)
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-6 border-t-2 border-dashed border-blue-500" />
                                <span className="font-mono text-xs">
                                    Distance
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
