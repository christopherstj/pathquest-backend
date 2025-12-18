import Peak from "../typeDefs/Peak";
import haversineDistanceMeters from "./haversineDistanceMeters";
import {
    RESET_GAP_SECONDS,
    ELEVATION_TOLERANCE,
    ELEVATION_PENALTY_RATE,
    CONFIDENCE_THRESHOLDS,
    SUMMIT_CONFIG,
    getSummitMode,
    SummitMode,
    SummitModeConfig,
} from "./summitConfig";

type SummitCandidate = {
    id: string;
    lat: number;
    lng: number;
    elevation?: number;
    index: number;
    confidenceScore: number;
    needsConfirmation: boolean;
};

type ActiveSummit = {
    active: boolean;
    startIndex: number;
    startTime: number;
    lastWithinIndex: number;
    lastWithinTime: number;
    minDistance: number;
    minIndex: number;
    samples: number;
    peak: Peak;
    // Elevation tracking for confidence scoring
    elevationSamples: number[];
    elevationAtMinDistance?: number;
};

type Point = {
    lat: number;
    lng: number;
    time: number;
    index: number;
    altitude?: number;
};

/**
 * Calculate distance score using exponential decay
 * Closer = higher score: 0m = 1.0, 40m = 0.85, 80m = 0.65
 */
const calculateDistanceScore = (minDistance: number): number => {
    return Math.exp(-minDistance / 60);
};

/**
 * Calculate elevation match score comparing GPS altitude vs peak elevation
 * Returns 1.0 if within tolerance, decays as difference grows
 */
const calculateElevationScore = (
    avgElevation: number | undefined,
    peakElevation: number | undefined
): number => {
    if (avgElevation === undefined || peakElevation === undefined) {
        return 1.0; // Neutral if data missing (handled by mode selection)
    }

    const elevationDiff = Math.abs(avgElevation - peakElevation);

    if (elevationDiff <= ELEVATION_TOLERANCE) {
        return 1.0;
    }

    // Smooth decay: tolerance = 1.0, tolerance + penalty_rate = 0.4
    return Math.max(
        0.2,
        1 - ((elevationDiff - ELEVATION_TOLERANCE) / ELEVATION_PENALTY_RATE) * 0.6
    );
};

/**
 * Calculate approach pattern score
 * Detects if user "peaked" near summit or just passed through at constant elevation
 */
const calculateApproachScore = (
    elevationSamples: number[],
    minDistanceIndex: number,
    startIndex: number
): number => {
    if (elevationSamples.length < 3) {
        return 0.85; // Neutral if insufficient data
    }

    // Find the relative position of minDistance in the window
    const relativeMinIndex = minDistanceIndex - startIndex;
    const windowSize = elevationSamples.length;

    // Split samples into before and after closest approach
    const splitPoint = Math.min(
        Math.max(1, relativeMinIndex),
        windowSize - 1
    );

    const samplesBefore = elevationSamples.slice(0, splitPoint);
    const samplesAfter = elevationSamples.slice(splitPoint);

    // Calculate average elevations
    const avgBefore =
        samplesBefore.length > 0
            ? samplesBefore.reduce((a, b) => a + b, 0) / samplesBefore.length
            : elevationSamples[0];
    const avgAfter =
        samplesAfter.length > 0
            ? samplesAfter.reduce((a, b) => a + b, 0) / samplesAfter.length
            : elevationSamples[elevationSamples.length - 1];

    // Get elevation at closest approach
    const elevAtMin =
        relativeMinIndex >= 0 && relativeMinIndex < windowSize
            ? elevationSamples[relativeMinIndex]
            : (avgBefore + avgAfter) / 2;

    // Calculate "peak shape" - did elevation rise toward closest approach?
    const minEdgeElevation = Math.min(avgBefore, avgAfter);
    const riseToSummit = elevAtMin - minEdgeElevation;

    // Expected rise based on typical summit approach
    const expectedRise = 5; // meters - minimum expected rise

    if (riseToSummit >= expectedRise) {
        // Bonus for strong approach pattern (capped at 1.15)
        return Math.min(1.15, 1.0 + riseToSummit / 100);
    } else if (riseToSummit >= 0) {
        // Neutral - flat approach possible for ridge walks
        return 0.85;
    } else {
        // Elevation DECREASED toward "summit" - suspicious
        return 0.6;
    }
};

/**
 * Calculate dwell score based on time and samples in summit window
 */
const calculateDwellScore = (
    samples: number,
    dwellSeconds: number,
    config: SummitModeConfig
): number => {
    const targetSamples = Math.max(config.minPoints, 5);
    const targetDwell = Math.max(config.minDwellSeconds, 45);

    const sampleScore = Math.min(1.0, samples / targetSamples);
    const timeScore = Math.min(1.0, dwellSeconds / targetDwell);

    // Range: 0.7 (minimal dwell) to 1.0 (strong dwell)
    return 0.7 + 0.3 * Math.max(sampleScore, timeScore);
};

/**
 * Calculate overall confidence score based on mode and available factors
 */
const calculateConfidence = (
    state: ActiveSummit,
    mode: SummitMode,
    config: SummitModeConfig,
    points: Point[]
): number => {
    const dwellSeconds = state.lastWithinTime - state.startTime;

    // Distance score (always used)
    const distanceScore = calculateDistanceScore(state.minDistance);

    // Dwell score (always used)
    const dwellScore = calculateDwellScore(state.samples, dwellSeconds, config);

    // Mode-specific scoring
    let confidence: number;

    if (mode === "A") {
        // Full data: all 4 factors
        const avgElevation =
            state.elevationSamples.length > 0
                ? state.elevationSamples.reduce((a, b) => a + b, 0) /
                  state.elevationSamples.length
                : undefined;
        const elevationScore = calculateElevationScore(
            avgElevation,
            state.peak.elevation
        );
        const approachScore = calculateApproachScore(
            state.elevationSamples,
            state.minIndex,
            state.startIndex
        );
        confidence = distanceScore * elevationScore * approachScore * dwellScore;
    } else if (mode === "B") {
        // GPS altitude only: distance, approach, dwell
        const approachScore = calculateApproachScore(
            state.elevationSamples,
            state.minIndex,
            state.startIndex
        );
        confidence = distanceScore * approachScore * dwellScore;
    } else {
        // Modes C and D: distance and dwell only
        confidence = distanceScore * dwellScore;
    }

    // Cap at 1.0
    return Math.min(1.0, confidence);
};

/**
 * Determine if summit should be logged and if it needs confirmation
 */
const evaluateSummit = (
    confidence: number,
    config: SummitModeConfig
): { shouldLog: boolean; needsConfirmation: boolean } => {
    if (confidence < CONFIDENCE_THRESHOLDS.REJECT) {
        return { shouldLog: false, needsConfirmation: false };
    }

    if (confidence < config.threshold) {
        // Below mode threshold but above reject - needs confirmation
        return { shouldLog: true, needsConfirmation: true };
    }

    // Above threshold - auto-accept
    return { shouldLog: true, needsConfirmation: false };
};

const detectSummits = (points: Point[], peaks: Peak[]): SummitCandidate[] => {
    if (points.length === 0 || peaks.length === 0) {
        return [];
    }

    // Determine if GPS altitude is available
    const hasGpsAltitude = points.some(
        (p) => p.altitude !== undefined && p.altitude !== null
    );

    const createInitialState = (peak: Peak): ActiveSummit => ({
        active: false,
        startIndex: -1,
        startTime: 0,
        lastWithinIndex: -1,
        lastWithinTime: 0,
        minDistance: Number.MAX_SAFE_INTEGER,
        minIndex: -1,
        samples: 0,
        peak,
        elevationSamples: [],
        elevationAtMinDistance: undefined,
    });

    const peakStates: Record<string, ActiveSummit> = {};
    const results: SummitCandidate[] = [];

    // Process each point
    points.forEach((pt) => {
        const time = pt.time;

        peaks.forEach((peak) => {
            const state = peakStates[peak.id] ?? createInitialState(peak);

            // Determine mode for this peak
            const hasPeakElevation =
                peak.elevation !== undefined && peak.elevation !== null;
            const mode = getSummitMode(hasGpsAltitude, hasPeakElevation);
            const config = SUMMIT_CONFIG[mode];

            // Precompute deltas for coarse filtering
            const latDelta = config.enterDistance / 110574;
            const lngDelta =
                config.enterDistance /
                    (111320 * Math.cos((peak.lat * Math.PI) / 180)) || 0.01;

            // Coarse bounding-box filter when inactive only
            const isCoarseFar =
                !state.active &&
                (Math.abs(peak.lat - pt.lat) > latDelta ||
                    Math.abs(peak.lng - pt.lng) > lngDelta);

            if (isCoarseFar) {
                peakStates[peak.id] = state;
                return;
            }

            const dist = haversineDistanceMeters(
                pt.lat,
                pt.lng,
                peak.lat,
                peak.lng
            );

            if (dist <= config.enterDistance) {
                // Enter or stay in summit window
                if (!state.active) {
                    state.active = true;
                    state.startIndex = pt.index;
                    state.startTime = time;
                    state.minDistance = dist;
                    state.minIndex = pt.index;
                    state.samples = 1;
                    state.elevationSamples = [];
                    if (pt.altitude !== undefined) {
                        state.elevationSamples.push(pt.altitude);
                        state.elevationAtMinDistance = pt.altitude;
                    }
                } else {
                    state.samples += 1;
                    if (pt.altitude !== undefined) {
                        state.elevationSamples.push(pt.altitude);
                    }
                }

                state.lastWithinIndex = pt.index;
                state.lastWithinTime = time;

                if (dist < state.minDistance) {
                    state.minDistance = dist;
                    state.minIndex = pt.index;
                    if (pt.altitude !== undefined) {
                        state.elevationAtMinDistance = pt.altitude;
                    }
                }
            } else if (state.active) {
                // Outside summit window
                const timeSinceLastWithin = time - state.lastWithinTime;
                const distanceExited = dist >= config.exitDistance;

                if (distanceExited && timeSinceLastWithin >= RESET_GAP_SECONDS) {
                    // Calculate confidence and decide
                    const confidence = calculateConfidence(
                        state,
                        mode,
                        config,
                        points
                    );
                    const { shouldLog, needsConfirmation } = evaluateSummit(
                        confidence,
                        config
                    );

                    if (shouldLog) {
                        results.push({
                            id: peak.id,
                            lat: points[state.minIndex].lat,
                            lng: points[state.minIndex].lng,
                            elevation: peak.elevation,
                            index: state.minIndex,
                            confidenceScore: confidence,
                            needsConfirmation,
                        });
                    }

                    // Reset state
                    peakStates[peak.id] = {
                        ...state,
                        active: false,
                        samples: 0,
                        startIndex: -1,
                        minDistance: Number.MAX_SAFE_INTEGER,
                        minIndex: -1,
                        elevationSamples: [],
                        elevationAtMinDistance: undefined,
                    };
                    return;
                }
            }

            peakStates[peak.id] = state;
        });
    });

    // Finalize any active summit at end
    Object.values(peakStates).forEach((state) => {
        if (!state.active) return;

        const peak = state.peak;
        const hasPeakElevation =
            peak.elevation !== undefined && peak.elevation !== null;
        const mode = getSummitMode(hasGpsAltitude, hasPeakElevation);
        const config = SUMMIT_CONFIG[mode];

        const confidence = calculateConfidence(state, mode, config, points);
        const { shouldLog, needsConfirmation } = evaluateSummit(
            confidence,
            config
        );

        if (shouldLog) {
            results.push({
                id: state.peak.id,
                lat: points[state.minIndex].lat,
                lng: points[state.minIndex].lng,
                elevation: state.peak.elevation,
                index: state.minIndex,
                confidenceScore: confidence,
                needsConfirmation,
            });
        }
    });

    return results.sort((a, b) => a.index - b.index);
};

export type { SummitCandidate, Point };
export default detectSummits;
