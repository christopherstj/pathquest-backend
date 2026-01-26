// Legacy constants (kept for backward compatibility during transition)
export const SEARCH_RADIUS_METERS = 500; // how far around the activity to fetch candidate peaks
export const ENTER_DISTANCE_METERS = 100; // distance to consider "at summit" (was 80)
export const EXIT_DISTANCE_METERS = 150; // distance to consider "left summit" for reset (was 120)
export const RESET_GAP_SECONDS = 180; // time away before allowing a new summit of same peak
export const MIN_DWELL_SECONDS = 20; // minimum time within ENTER distance to count (was 30)
export const MIN_POINTS = 2; // minimum samples within ENTER distance to count (was 3)
export const MAX_CANDIDATE_PEAKS = 2000; // guard against runaway candidate sets

// Elevation scoring constants
export const ELEVATION_TOLERANCE = 75; // meters - allowance for GPS error
export const ELEVATION_PENALTY_RATE = 150; // meters - full penalty range beyond tolerance

// Confidence thresholds for summit detection
// Loosened Jan 2026 to catch more edge cases (fast hikers, GPS drift)
export const CONFIDENCE_THRESHOLDS = {
    HIGH: 0.70,      // Auto-accept: very confident
    MEDIUM: 0.50,    // Auto-accept: balanced threshold (was 0.55)
    LOW: 0.45,       // Needs confirmation: edge case (was 0.55)
    REJECT: 0.40,    // Below this: don't log at all (was 0.55)
};

// Mode-specific configuration based on data availability
export type SummitMode = 'A' | 'B' | 'C' | 'D';

export interface SummitModeConfig {
    enterDistance: number;
    exitDistance: number;
    threshold: number;
    useElevationMatch: boolean;
    useApproachPattern: boolean;
    minDwellSeconds: number;
    minPoints: number;
}

export const SUMMIT_CONFIG: Record<SummitMode, SummitModeConfig> = {
    // Mode A: Full data (GPS altitude + peak elevation)
    // Loosened Jan 2026 to catch more edge cases
    A: {
        enterDistance: 100,  // was 80
        exitDistance: 150,   // was 120
        threshold: 0.55,     // was 0.65
        useElevationMatch: true,
        useApproachPattern: true,
        minDwellSeconds: 20, // was 30
        minPoints: 2,        // was 3
    },
    // Mode B: GPS altitude only (no peak elevation)
    B: {
        enterDistance: 80,   // was 60
        exitDistance: 120,   // was 100
        threshold: 0.50,     // was 0.60
        useElevationMatch: false,
        useApproachPattern: true,
        minDwellSeconds: 20, // was 30
        minPoints: 2,        // was 3
    },
    // Mode C: Peak elevation only (no GPS altitude)
    C: {
        enterDistance: 60,   // was 40
        exitDistance: 100,   // was 70
        threshold: 0.60,     // was 0.70
        useElevationMatch: false,
        useApproachPattern: false,
        minDwellSeconds: 25, // was 35
        minPoints: 3,        // was 4
    },
    // Mode D: No elevation data (neither available)
    D: {
        enterDistance: 50,   // was 35
        exitDistance: 80,    // was 60
        threshold: 0.65,     // was 0.75
        useElevationMatch: false,
        useApproachPattern: false,
        minDwellSeconds: 30, // was 45
        minPoints: 3,        // was 5
    },
};

/**
 * Determines the scoring mode based on available data
 */
export const getSummitMode = (
    hasGpsAltitude: boolean,
    hasPeakElevation: boolean
): SummitMode => {
    if (hasGpsAltitude && hasPeakElevation) return 'A';
    if (hasGpsAltitude) return 'B';
    if (hasPeakElevation) return 'C';
    return 'D';
};
