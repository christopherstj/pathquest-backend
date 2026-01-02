import { Pool } from "pg";
import { ExternalPeak } from "../typeDefs/ChallengeImport";
import getCloudSqlConnection from "./getCloudSqlConnection";
import { calculateNameSimilarity } from "./matchPeaksToOsm";
import * as path from "path";
import * as fs from "fs";

export interface PeakCandidate {
    peak_id: string;
    name: string;
    elevation: number | null;
    distance_meters: number;
}

export interface MatchEdge {
    externalIndex: number;
    peakId: string;
    score: number;
    distanceMeters: number;
    nameSimilarity: number;
    elevationScore: number;
}

export interface OneToOneMatch {
    external: ExternalPeak;
    externalPeakbaggerId: string;
    peakId: string;
    peakName: string;
    distanceMeters: number;
    score: number;
    nameSimilarity: number;
    secondBestScore: number | null;
    secondBestPeakId: string | null;
}

export interface PeakbaggerMatchOutputs {
    matchedHigh: OneToOneMatch[];
    matchedReview: OneToOneMatch[];
    unmatched: ExternalPeak[];
    skippedAlreadyLinked: ExternalPeak[];
}

export interface MatchOptions {
    matchRadiusMeters: number;
    maxCandidates: number;
    minScoreToConsider: number;
    autoAcceptMinScore: number;
    autoAcceptMaxDistanceMeters: number;
    autoAcceptMinNameSimilarity: number;
    minMarginForAutoAccept: number;
}

const DEFAULTS: MatchOptions = {
    matchRadiusMeters: 2000,
    maxCandidates: 25,
    minScoreToConsider: 0.35,
    autoAcceptMinScore: 0.75,
    autoAcceptMaxDistanceMeters: 150,
    autoAcceptMinNameSimilarity: 0.7,
    minMarginForAutoAccept: 0.12,
};

const getExistingPeakbaggerIds = async (
    pool: Pool,
    peakbaggerIds: string[]
): Promise<Set<string>> => {
    if (peakbaggerIds.length === 0) return new Set();

    // Chunk to avoid very large IN lists
    const chunkSize = 5000;
    const existing = new Set<string>();
    for (let i = 0; i < peakbaggerIds.length; i += chunkSize) {
        const chunk = peakbaggerIds.slice(i, i + chunkSize);
        const { rows } = await pool.query<{ external_id: string }>(
            `
            SELECT external_id
            FROM peak_external_ids
            WHERE source = 'peakbagger'
              AND external_id = ANY($1)
        `,
            [chunk]
        );
        for (const r of rows) existing.add(r.external_id);
    }
    return existing;
};

const calculateElevationScore = (externalMeters: number, dbMeters: number | null): number => {
    if (!dbMeters || !externalMeters) return 0.5;
    const diff = Math.abs(externalMeters - dbMeters);
    if (diff < 50) return 1.0;
    if (diff > 200) return 0;
    return 1 - (diff - 50) / 150;
};

const scoreCandidate = (external: ExternalPeak, c: PeakCandidate, radiusMeters: number) => {
    const nameSimilarity = calculateNameSimilarity(external.name, c.name);
    const distanceScore = 1 - c.distance_meters / radiusMeters;
    const elevationScore = calculateElevationScore(external.elevation, c.elevation);
    const score = nameSimilarity * 0.5 + distanceScore * 0.3 + elevationScore * 0.2;
    return { score, nameSimilarity, elevationScore };
};

const findCandidates = async (
    pool: Pool,
    external: ExternalPeak,
    opts: MatchOptions
): Promise<PeakCandidate[]> => {
    // Exclude peaks already linked to any peakbagger id to prevent accidental remaps.
    const { rows } = await pool.query<PeakCandidate>(
        `
        SELECT
            p.id AS peak_id,
            p.name,
            p.elevation,
            ST_Distance(
                p.location_coords,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
            ) AS distance_meters
        FROM peaks p
        WHERE ST_DWithin(
            p.location_coords,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3
        )
        AND NOT EXISTS (
            SELECT 1
            FROM peak_external_ids pei
            WHERE pei.peak_id = p.id
              AND pei.source = 'peakbagger'
        )
        ORDER BY distance_meters ASC
        LIMIT $4
    `,
        [external.lng, external.lat, opts.matchRadiusMeters, opts.maxCandidates]
    );
    return rows;
};

export const matchPeakbaggerPeaksOneToOne = async (
    pool: Pool,
    peaks: ExternalPeak[],
    options?: Partial<MatchOptions>
): Promise<PeakbaggerMatchOutputs> => {
    const opts: MatchOptions = { ...DEFAULTS, ...(options ?? {}) };

    const peakbaggerIds = peaks.map((p) => p.peakId).filter((x): x is string => typeof x === "string");
    const existingPbIds = await getExistingPeakbaggerIds(pool, peakbaggerIds);

    const toProcess: { peak: ExternalPeak; index: number }[] = [];
    const skippedAlreadyLinked: ExternalPeak[] = [];
    const skippedIndices = new Set<number>();

    peaks.forEach((p, idx) => {
        if (!p.peakId) {
            // Shouldn't happen for scraped PB peaks, but keep safe.
            toProcess.push({ peak: p, index: idx });
            return;
        }
        if (existingPbIds.has(p.peakId)) {
            skippedAlreadyLinked.push(p);
            skippedIndices.add(idx);
            return;
        }
        toProcess.push({ peak: p, index: idx });
    });

    console.log(`\nPeakbagger peaks: ${peaks.length}`);
    console.log(`Already linked (skipped): ${skippedAlreadyLinked.length}`);
    console.log(`To match: ${toProcess.length}`);

    const edges: MatchEdge[] = [];
    const perExternalBest: Array<{
        bestScore: number;
        bestPeakId: string | null;
        secondBestScore: number | null;
        secondBestPeakId: string | null;
        bestDistance: number;
        bestNameSimilarity: number;
    }> = new Array(peaks.length).fill(null).map(() => ({
        bestScore: 0,
        bestPeakId: null,
        secondBestScore: null,
        secondBestPeakId: null,
        bestDistance: Infinity,
        bestNameSimilarity: 0,
    }));

    for (let i = 0; i < toProcess.length; i++) {
        const { peak, index } = toProcess[i];
        const candidates = await findCandidates(pool, peak, opts);
        const scored = candidates
            .map((c) => {
                const { score, nameSimilarity, elevationScore } = scoreCandidate(peak, c, opts.matchRadiusMeters);
                return { c, score, nameSimilarity, elevationScore };
            })
            .sort((a, b) => b.score - a.score);

        const best = scored[0];
        const second = scored[1];
        if (best && best.score >= opts.minScoreToConsider) {
            perExternalBest[index] = {
                bestScore: best.score,
                bestPeakId: best.c.peak_id,
                secondBestScore: second?.score ?? null,
                secondBestPeakId: second?.c.peak_id ?? null,
                bestDistance: best.c.distance_meters,
                bestNameSimilarity: best.nameSimilarity,
            };
        }

        for (const s of scored) {
            if (s.score < opts.minScoreToConsider) continue;
            edges.push({
                externalIndex: index,
                peakId: s.c.peak_id,
                score: s.score,
                distanceMeters: s.c.distance_meters,
                nameSimilarity: s.nameSimilarity,
                elevationScore: s.elevationScore,
            });
        }

        if ((i + 1) % 50 === 0) {
            console.log(`Generated candidates: ${i + 1}/${toProcess.length}`);
        }
    }

    // Greedy bipartite matching by score (enforces 1:1).
    edges.sort((a, b) => b.score - a.score);
    const usedExternal = new Set<number>();
    const usedPeaks = new Set<string>();

    const assignedByExternal = new Map<number, MatchEdge>();
    for (const e of edges) {
        if (usedExternal.has(e.externalIndex)) continue;
        if (usedPeaks.has(e.peakId)) continue;
        usedExternal.add(e.externalIndex);
        usedPeaks.add(e.peakId);
        assignedByExternal.set(e.externalIndex, e);
    }

    const matchedHigh: OneToOneMatch[] = [];
    const matchedReview: OneToOneMatch[] = [];
    const unmatched: ExternalPeak[] = [];

    // We need peak names for reporting; fetch in one go for assigned peaks
    const assignedPeakIds = [...assignedByExternal.values()].map((e) => e.peakId);
    const peakNameById = new Map<string, string>();
    if (assignedPeakIds.length > 0) {
        const { rows } = await pool.query<{ id: string; name: string }>(
            `SELECT id, name FROM peaks WHERE id = ANY($1)`,
            [assignedPeakIds]
        );
        for (const r of rows) peakNameById.set(r.id, r.name);
    }

    for (let i = 0; i < peaks.length; i++) {
        const external = peaks[i];
        if (skippedIndices.has(i)) continue;

        const best = perExternalBest[i];
        const assigned = assignedByExternal.get(i);

        if (!assigned || !best.bestPeakId) {
            unmatched.push(external);
            continue;
        }

        const oneToOne: OneToOneMatch = {
            external,
            externalPeakbaggerId: external.peakId ?? "",
            peakId: assigned.peakId,
            peakName: peakNameById.get(assigned.peakId) ?? "(unknown)",
            distanceMeters: assigned.distanceMeters,
            score: assigned.score,
            nameSimilarity: assigned.nameSimilarity,
            secondBestScore: best.secondBestScore,
            secondBestPeakId: best.secondBestPeakId,
        };

        const margin =
            best.secondBestScore !== null ? best.bestScore - best.secondBestScore : null;

        const autoAccept =
            assigned.score >= opts.autoAcceptMinScore &&
            assigned.distanceMeters <= opts.autoAcceptMaxDistanceMeters &&
            assigned.nameSimilarity >= opts.autoAcceptMinNameSimilarity &&
            (margin === null || margin >= opts.minMarginForAutoAccept);

        if (autoAccept) {
            matchedHigh.push(oneToOne);
        } else {
            matchedReview.push(oneToOne);
        }
    }

    console.log(`\n1:1 Matching results:`);
    console.log(`  matched-high:   ${matchedHigh.length}`);
    console.log(`  matched-review: ${matchedReview.length}`);
    console.log(`  unmatched:      ${unmatched.length}`);

    return { matchedHigh, matchedReview, unmatched, skippedAlreadyLinked };
};

export const writePeakbaggerMatchOutputs = async (
    outputs: PeakbaggerMatchOutputs,
    opts: { outDir: string; listId: string }
): Promise<{
    matchedHigh: string;
    matchedReview: string;
    unmatched: string;
    skippedAlreadyLinked: string;
}> => {
    const outDir = opts.outDir || ".";
    fs.mkdirSync(outDir, { recursive: true });

    const matchedHighPath = path.join(outDir, `pb-${opts.listId}-matched-high.json`);
    const matchedReviewPath = path.join(outDir, `pb-${opts.listId}-matched-review.json`);
    const unmatchedPath = path.join(outDir, `pb-${opts.listId}-unmatched.json`);
    const skippedPath = path.join(outDir, `pb-${opts.listId}-skipped-already-linked.json`);

    fs.writeFileSync(matchedHighPath, JSON.stringify(outputs.matchedHigh, null, 2));
    fs.writeFileSync(matchedReviewPath, JSON.stringify(outputs.matchedReview, null, 2));
    fs.writeFileSync(unmatchedPath, JSON.stringify(outputs.unmatched, null, 2));
    fs.writeFileSync(skippedPath, JSON.stringify(outputs.skippedAlreadyLinked, null, 2));

    return {
        matchedHigh: matchedHighPath,
        matchedReview: matchedReviewPath,
        unmatched: unmatchedPath,
        skippedAlreadyLinked: skippedPath,
    };
};

export default async function matchPeakbaggerPeaksOneToOneRunner(
    pool: Pool | undefined,
    peaks: ExternalPeak[],
    options?: Partial<MatchOptions>
): Promise<PeakbaggerMatchOutputs> {
    const db = pool || (await getCloudSqlConnection());
    return matchPeakbaggerPeaksOneToOne(db, peaks, options);
}


