import Peak from "../typeDefs/Peak";
import haversineDistanceMeters from "./haversineDistanceMeters";
import {
    ENTER_DISTANCE_METERS,
    EXIT_DISTANCE_METERS,
    MIN_DWELL_SECONDS,
    MIN_POINTS,
    RESET_GAP_SECONDS,
} from "./summitConfig";

type SummitCandidate = {
    id: string;
    lat: number;
    lng: number;
    elevation?: number;
    index: number;
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
};

type Point = {
    lat: number;
    lng: number;
    time: number;
    index: number;
};

const shouldFinalize = (state: ActiveSummit) => {
    const dwellSeconds = state.lastWithinTime - state.startTime;
    return (
        state.samples >= MIN_POINTS ||
        dwellSeconds >= MIN_DWELL_SECONDS ||
        state.minDistance <= ENTER_DISTANCE_METERS * 0.5
    );
};

const detectSummits = (
    points: Point[],
    peaks: Peak[]
): SummitCandidate[] => {
    if (points.length === 0 || peaks.length === 0) {
        return [];
    }

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
    });

    const peakStates: Record<string, ActiveSummit> = {};
    const results: SummitCandidate[] = [];

    // Precompute per-peak quick deltas for coarse filtering
    const peakDeltas = peaks.map((peak) => {
        const latDelta = Math.abs(
            (ENTER_DISTANCE_METERS / 110574) // degrees latitude per meter
        );
        const lngDelta =
            (ENTER_DISTANCE_METERS /
                (111320 * Math.cos((peak.lat * Math.PI) / 180))) || 0.01;
        return { id: peak.id, latDelta, lngDelta };
    });

    points.forEach((pt) => {
        const time = pt.time;

        peaks.forEach((peak, idx) => {
            const state = peakStates[peak.id] ?? createInitialState(peak);

            // coarse bounding-box filter when inactive only
            const deltas = peakDeltas[idx];
            const isCoarseFar =
                !state.active &&
                (Math.abs(peak.lat - pt.lat) > deltas.latDelta ||
                    Math.abs(peak.lng - pt.lng) > deltas.lngDelta);
            if (isCoarseFar) {
                return;
            }

            const dist = haversineDistanceMeters(
                pt.lat,
                pt.lng,
                peak.lat,
                peak.lng
            );

            if (dist <= ENTER_DISTANCE_METERS) {
                // Enter or stay in summit window
                if (!state.active) {
                    state.active = true;
                    state.startIndex = pt.index;
                    state.startTime = time;
                    state.minDistance = dist;
                    state.minIndex = pt.index;
                    state.samples = 1;
                } else {
                    state.samples += 1;
                }

                state.lastWithinIndex = pt.index;
                state.lastWithinTime = time;
                if (dist < state.minDistance) {
                    state.minDistance = dist;
                    state.minIndex = pt.index;
                }
            } else if (state.active) {
                // Outside summit window
                const timeSinceLastWithin = time - state.lastWithinTime;
                const distanceExited = dist >= EXIT_DISTANCE_METERS;

                if (distanceExited && timeSinceLastWithin >= RESET_GAP_SECONDS) {
                    if (shouldFinalize(state)) {
                        results.push({
                            id: peak.id,
                            lat: points[state.minIndex].lat,
                            lng: points[state.minIndex].lng,
                            elevation: peak.elevation,
                            index: state.minIndex,
                        });
                    }
                    // reset
                    peakStates[peak.id] = {
                        ...state,
                        active: false,
                        samples: 0,
                        startIndex: -1,
                        minDistance: Number.MAX_SAFE_INTEGER,
                        minIndex: -1,
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
        if (shouldFinalize(state)) {
            results.push({
                id: state.peak.id,
                lat: points[state.minIndex].lat,
                lng: points[state.minIndex].lng,
                elevation: state.peak.elevation,
                index: state.minIndex,
            });
        }
    });

    return results.sort((a, b) => a.index - b.index);
};

export type { SummitCandidate, Point };
export default detectSummits;


