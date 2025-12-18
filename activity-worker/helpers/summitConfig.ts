// Legacy constants (kept for backward compatibility during transition)
export const SEARCH_RADIUS_METERS = 500; // how far around the activity to fetch candidate peaks
export const ENTER_DISTANCE_METERS = 80; // distance to consider "at summit"
export const EXIT_DISTANCE_METERS = 120; // distance to consider "left summit" for reset
export const RESET_GAP_SECONDS = 180; // time away before allowing a new summit of same peak
export const MIN_DWELL_SECONDS = 30; // minimum time within ENTER distance to count
export const MIN_POINTS = 3; // minimum samples within ENTER distance to count
export const MAX_CANDIDATE_PEAKS = 2000; // guard against runaway candidate sets

// Elevation scoring constants
export const ELEVATION_TOLERANCE = 75; // meters - allowance for GPS error
export const ELEVATION_PENALTY_RATE = 150; // meters - full penalty range beyond tolerance

// Confidence thresholds for summit detection
export const CONFIDENCE_THRESHOLDS = {
    HIGH: 0.70,      // Auto-accept: very confident
    MEDIUM: 0.55,    // Auto-accept: balanced threshold
    LOW: 0.55,       // Needs confirmation: edge case (raised from 0.45)
    REJECT: 0.55,    // Below this: don't log at all (raised from 0.45)
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
    // Stricter threshold since we have elevation data to be more precise
    A: {
        enterDistance: 80,
        exitDistance: 120,
        threshold: 0.65,  // Increased from 0.55 to reduce false positives
        useElevationMatch: true,
        useApproachPattern: true,
        minDwellSeconds: 30,
        minPoints: 3,
    },
    // Mode B: GPS altitude only (no peak elevation)
    B: {
        enterDistance: 60,
        exitDistance: 100,
        threshold: 0.60,
        useElevationMatch: false,
        useApproachPattern: true,
        minDwellSeconds: 30,
        minPoints: 3,
    },
    // Mode C: Peak elevation only (no GPS altitude)
    C: {
        enterDistance: 40,
        exitDistance: 70,
        threshold: 0.70,
        useElevationMatch: false,
        useApproachPattern: false,
        minDwellSeconds: 35,
        minPoints: 4,
    },
    // Mode D: No elevation data (neither available)
    D: {
        enterDistance: 35,
        exitDistance: 60,
        threshold: 0.75,
        useElevationMatch: false,
        useApproachPattern: false,
        minDwellSeconds: 45,
        minPoints: 5,
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
