import { Pool } from "pg";
import {
    ExternalPeak,
    MatchResult,
    ChallengeImportResult,
    ChallengeDefinition,
} from "../typeDefs/ChallengeImport";
import getCloudSqlConnection from "./getCloudSqlConnection";

// Configuration for matching
const MATCH_RADIUS_METERS = 500; // Search within 500m of external peak
const HIGH_CONFIDENCE_DISTANCE = 100; // Within 100m
const MEDIUM_CONFIDENCE_DISTANCE = 300; // Within 300m
const HIGH_CONFIDENCE_NAME_SCORE = 0.7;
const MEDIUM_CONFIDENCE_NAME_SCORE = 0.4;

interface OsmPeakCandidate {
    id: string;
    name: string;
    elevation: number | null;
    distance_meters: number;
}

/**
 * Match a list of external peaks to OSM peaks in the database
 */
export const matchPeaksToOsm = async (
    externalPeaks: ExternalPeak[],
    pool?: Pool
): Promise<MatchResult[]> => {
    const db = pool || (await getCloudSqlConnection());
    const results: MatchResult[] = [];

    console.log(`\nMatching ${externalPeaks.length} peaks to OSM database...`);

    for (let i = 0; i < externalPeaks.length; i++) {
        const peak = externalPeaks[i];
        const match = await matchSinglePeak(db, peak);
        results.push(match);

        // Progress update every 50 peaks
        if ((i + 1) % 50 === 0) {
            console.log(`Matched ${i + 1}/${externalPeaks.length} peaks`);
        }
    }

    console.log(`Completed matching ${externalPeaks.length} peaks`);
    return results;
};

/**
 * Match a single external peak to the best OSM candidate
 */
const matchSinglePeak = async (
    db: Pool,
    external: ExternalPeak
): Promise<MatchResult> => {
    // Find OSM peaks within radius, ordered by distance
    const query = `
        SELECT 
            id,
            name,
            elevation,
            ST_Distance(
                location_coords,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
            ) as distance_meters
        FROM peaks
        WHERE ST_DWithin(
            location_coords,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3
        )
        ORDER BY distance_meters ASC
        LIMIT 10
    `;

    const { rows } = await db.query<OsmPeakCandidate>(query, [
        external.lng,
        external.lat,
        MATCH_RADIUS_METERS,
    ]);

    if (rows.length === 0) {
        return {
            external,
            osmPeakId: null,
            osmName: null,
            osmElevation: null,
            distance: Infinity,
            nameSimilarity: 0,
            confidence: "none",
        };
    }

    // Score each candidate and pick the best
    let bestMatch: OsmPeakCandidate = rows[0];
    let bestScore = 0;
    let bestNameSimilarity = 0;

    for (const candidate of rows) {
        const nameSim = calculateNameSimilarity(external.name, candidate.name);
        const distanceScore = 1 - candidate.distance_meters / MATCH_RADIUS_METERS;
        const elevationScore = calculateElevationScore(
            external.elevation,
            candidate.elevation
        );

        // Weighted score: name (50%), distance (30%), elevation (20%)
        const totalScore = nameSim * 0.5 + distanceScore * 0.3 + elevationScore * 0.2;

        if (totalScore > bestScore) {
            bestScore = totalScore;
            bestMatch = candidate;
            bestNameSimilarity = nameSim;
        }
    }

    // Determine confidence level
    let confidence: "high" | "medium" | "low";
    if (
        bestMatch.distance_meters < HIGH_CONFIDENCE_DISTANCE &&
        bestNameSimilarity > HIGH_CONFIDENCE_NAME_SCORE
    ) {
        confidence = "high";
    } else if (
        bestMatch.distance_meters < MEDIUM_CONFIDENCE_DISTANCE &&
        bestNameSimilarity > MEDIUM_CONFIDENCE_NAME_SCORE
    ) {
        confidence = "medium";
    } else if (bestMatch.distance_meters < HIGH_CONFIDENCE_DISTANCE) {
        // Very close but name doesn't match well - could be unnamed peak
        confidence = "medium";
    } else {
        confidence = "low";
    }

    return {
        external,
        osmPeakId: bestMatch.id,
        osmName: bestMatch.name,
        osmElevation: bestMatch.elevation,
        distance: bestMatch.distance_meters,
        nameSimilarity: bestNameSimilarity,
        confidence,
    };
};

/**
 * Calculate name similarity using normalized words and Jaccard coefficient
 */
export const calculateNameSimilarity = (a: string, b: string): number => {
    if (!a || !b) return 0;

    const normalize = (s: string): Set<string> => {
        // Normalize common mountain name variations
        const normalized = s
            .toLowerCase()
            .replace(/\b(mount|mt\.?|mountain|mtn\.?)\b/gi, "mt")
            .replace(/\b(peak|pk\.?)\b/gi, "pk")
            .replace(/\b(point|pt\.?)\b/gi, "pt")
            .replace(/[''`]/g, "") // Remove apostrophes
            .replace(/[^\w\s]/g, " ") // Remove punctuation
            .trim();

        const words = normalized.split(/\s+/).filter((w) => w.length > 1);
        return new Set(words);
    };

    const wordsA = normalize(a);
    const wordsB = normalize(b);

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    // Jaccard coefficient
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;

    const jaccard = union > 0 ? intersection / union : 0;

    // Bonus for exact normalized match
    const normalizedA = [...wordsA].sort().join(" ");
    const normalizedB = [...wordsB].sort().join(" ");
    if (normalizedA === normalizedB) return 1.0;

    // Bonus for substring match (one contains the other)
    if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
        return Math.max(jaccard, 0.8);
    }

    return jaccard;
};

/**
 * Score elevation match (0-1)
 */
const calculateElevationScore = (
    external: number,
    osm: number | null
): number => {
    if (!osm || !external) return 0.5; // Neutral if no elevation data

    const diff = Math.abs(external - osm);
    // Within 50m is perfect, degrades linearly to 0 at 200m difference
    if (diff < 50) return 1.0;
    if (diff > 200) return 0;
    return 1 - (diff - 50) / 150;
};

/**
 * Generate a full import result with statistics
 */
export const generateImportResult = (
    challenge: ChallengeDefinition,
    matches: MatchResult[]
): ChallengeImportResult => {
    const stats = {
        total: matches.length,
        highConfidence: matches.filter((m) => m.confidence === "high").length,
        mediumConfidence: matches.filter((m) => m.confidence === "medium").length,
        lowConfidence: matches.filter((m) => m.confidence === "low").length,
        noMatch: matches.filter((m) => m.confidence === "none").length,
    };

    return { challenge, matches, stats };
};

/**
 * Print a human-readable match report
 */
export const printMatchReport = (result: ChallengeImportResult): void => {
    console.log("\n" + "=".repeat(80));
    console.log(`MATCH REPORT: ${result.challenge.name}`);
    console.log("=".repeat(80));
    console.log(`\nStatistics:`);
    console.log(`  Total peaks: ${result.stats.total}`);
    console.log(`  High confidence:   ${result.stats.highConfidence} (${pct(result.stats.highConfidence, result.stats.total)})`);
    console.log(`  Medium confidence: ${result.stats.mediumConfidence} (${pct(result.stats.mediumConfidence, result.stats.total)})`);
    console.log(`  Low confidence:    ${result.stats.lowConfidence} (${pct(result.stats.lowConfidence, result.stats.total)})`);
    console.log(`  No match:          ${result.stats.noMatch} (${pct(result.stats.noMatch, result.stats.total)})`);

    // High confidence matches
    const high = result.matches.filter((m) => m.confidence === "high");
    if (high.length > 0) {
        console.log(`\n${"─".repeat(80)}`);
        console.log("HIGH CONFIDENCE MATCHES (will auto-insert):");
        console.log("─".repeat(80));
        for (const m of high.slice(0, 10)) {
            console.log(
                `  ✓ ${m.external.name} → ${m.osmName} (${Math.round(m.distance)}m, ${Math.round(m.nameSimilarity * 100)}% name)`
            );
        }
        if (high.length > 10) {
            console.log(`  ... and ${high.length - 10} more`);
        }
    }

    // Medium confidence matches
    const medium = result.matches.filter((m) => m.confidence === "medium");
    if (medium.length > 0) {
        console.log(`\n${"─".repeat(80)}`);
        console.log("MEDIUM CONFIDENCE MATCHES (review recommended):");
        console.log("─".repeat(80));
        for (const m of medium.slice(0, 15)) {
            console.log(
                `  ? ${m.external.name} → ${m.osmName} (${Math.round(m.distance)}m, ${Math.round(m.nameSimilarity * 100)}% name)`
            );
        }
        if (medium.length > 15) {
            console.log(`  ... and ${medium.length - 15} more`);
        }
    }

    // Low confidence matches
    const low = result.matches.filter((m) => m.confidence === "low");
    if (low.length > 0) {
        console.log(`\n${"─".repeat(80)}`);
        console.log("LOW CONFIDENCE MATCHES (manual verification needed):");
        console.log("─".repeat(80));
        for (const m of low.slice(0, 10)) {
            console.log(
                `  ⚠ ${m.external.name} → ${m.osmName || "???"} (${Math.round(m.distance)}m, ${Math.round(m.nameSimilarity * 100)}% name)`
            );
        }
        if (low.length > 10) {
            console.log(`  ... and ${low.length - 10} more`);
        }
    }

    // No matches
    const none = result.matches.filter((m) => m.confidence === "none");
    if (none.length > 0) {
        console.log(`\n${"─".repeat(80)}`);
        console.log("NO MATCH FOUND:");
        console.log("─".repeat(80));
        for (const m of none.slice(0, 10)) {
            console.log(
                `  ✗ ${m.external.name} (${m.external.lat.toFixed(4)}, ${m.external.lng.toFixed(4)}) - No OSM peak within ${MATCH_RADIUS_METERS}m`
            );
        }
        if (none.length > 10) {
            console.log(`  ... and ${none.length - 10} more`);
        }
    }

    console.log("\n" + "=".repeat(80) + "\n");
};

const pct = (n: number, total: number): string => {
    if (total === 0) return "0%";
    return `${Math.round((n / total) * 100)}%`;
};

export default matchPeaksToOsm;








