// Type definitions for challenge import pipeline

export interface ExternalPeak {
    name: string;
    lat: number;
    lng: number;
    elevation: number; // in meters
    prominence?: number; // in meters
    rank?: number;
    peakId?: string; // Peakbagger peak ID for re-fetching
    county?: string; // County/Second Level Region from Peakbagger
    externalSource?: string; // e.g. 'peakbagger', 'climb13ers'
    externalId?: string; // source-specific identifier (e.g. URL, slug, numeric id)
    sourceUrl?: string; // canonical URL for provenance
    // Optional source-specific fields (used by 14ers.com / other sources)
    coRank?: number; // Colorado rank (if provided by source)
    thirteenRank?: number; // 13er rank (if provided by source)
    range?: string; // Range name (if provided by source)
    elevationFeet?: number; // Original feet value from source (if provided)
}

export interface ChallengeDefinition {
    id: number;
    name: string;
    region: string;
    description: string;
    centerLat: number;
    centerLng: number;
}

export interface MatchResult {
    external: ExternalPeak;
    osmPeakId: string | null;
    osmName: string | null;
    osmElevation: number | null;
    distance: number;
    nameSimilarity: number;
    confidence: "high" | "medium" | "low" | "none";
    createNew?: boolean; // If true, create a new peak even if matched (match was incorrect)
}

export interface ChallengeImportResult {
    challenge: ChallengeDefinition;
    matches: MatchResult[];
    stats: {
        total: number;
        highConfidence: number;
        mediumConfidence: number;
        lowConfidence: number;
        noMatch: number;
    };
}

export interface PeakbaggerListConfig {
    listId: string;
    name: string;
    region: string;
    description: string;
}

// Well-known Peakbagger list IDs
export const PEAKBAGGER_LISTS: Record<string, PeakbaggerListConfig> = {
    CO_13ERS: {
        listId: "21364",
        name: "Colorado 13ers (All)",
        region: "Colorado",
        description: "Colorado 13ers list including ranked and unranked peaks (used as the seed list; ranked filtering can be applied later for challenges)."
    },
    CO_13ERS_RANKED: {
        listId: "5061",
        name: "Colorado Ranked 13ers",
        region: "Colorado",
        description: "All ranked peaks in Colorado between 13,000 and 14,000 feet with at least 300 feet of prominence."
    },
    CO_SOFT_13ERS: {
        listId: "5071",
        name: "Colorado Soft 13ers",
        region: "Colorado", 
        description: "Colorado peaks between 13,000 and 14,000 feet with less than 300 feet of prominence."
    },
    WA_BULGER: {
        listId: "5012",
        name: "Washington Bulger List",
        region: "Washington",
        description: "The 100 highest peaks in Washington State."
    },
    CASCADE_VOLCANOES: {
        listId: "5001",
        name: "Cascade Volcanoes",
        region: "Pacific Northwest",
        description: "Major volcanic peaks of the Cascade Range."
    },
    ADK_46ERS: {
        listId: "5120",
        name: "Adirondack 46ers",
        region: "New York",
        description: "The 46 High Peaks of the Adirondack Mountains in New York."
    },
    CATSKILL_35: {
        listId: "6031",
        name: "Catskill 35",
        region: "New York",
        description: "The 35 peaks over 3,500 feet in the Catskill Mountains."
    },
    SOCAL_SIX_PACK: {
        listId: "12001",
        name: "SoCal Six-Pack of Peaks",
        region: "Southern California",
        description: "Six iconic peaks in Southern California for the Six-Pack of Peaks Challenge."
    },
    SIERRA_PEAKS: {
        listId: "5051", 
        name: "Sierra Peaks Section List",
        region: "California",
        description: "The Sierra Peaks Section list maintained by the Sierra Club."
    },
    OR_CASCADES: {
        listId: "5081",
        name: "Oregon Cascade High Peaks",
        region: "Oregon",
        description: "High peaks of the Oregon Cascades."
    },
    WHITE_MTN_4K: {
        listId: "6001",
        name: "White Mountain 4000-Footers",
        region: "New Hampshire",
        description: "The 48 peaks over 4,000 feet in the White Mountains of New Hampshire."
    },
    VERMONT_4K: {
        listId: "6021",
        name: "Vermont 4000-Footers",
        region: "Vermont",
        description: "The 5 peaks over 4,000 feet in Vermont."
    },
    MAINE_4K: {
        listId: "6041",
        name: "Maine 4000-Footers",
        region: "Maine", 
        description: "The peaks over 4,000 feet in Maine."
    }
};

