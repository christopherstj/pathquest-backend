import { Pool } from "pg";
import { ExternalPeak } from "../typeDefs/ChallengeImport";
import { calculateNameSimilarity } from "./matchPeaksToOsm";
import * as fs from "fs";
import * as path from "path";

export type MatchOptions = {
    matchRadiusMeters: number;
    maxCandidates: number;
    minScoreToConsider: number;
    autoAcceptMinScore: number;
    autoAcceptMaxDistanceMeters: number;
    autoAcceptMinNameSimilarity: number;
    minMarginForAutoAccept: number;
};

const DEFAULTS: MatchOptions = {
    matchRadiusMeters: 2000,
    maxCandidates: 25,
    minScoreToConsider: 0.35,
    autoAcceptMinScore: 0.75,
    autoAcceptMaxDistanceMeters: 150,
    autoAcceptMinNameSimilarity: 0.7,
    minMarginForAutoAccept: 0.12,
};

type PeakCandidate = {
    peak_id: string;
    name: string;
    elevation: number | null;
    distance_meters: number;
};

type MatchEdge = {
    externalIndex: number;
    peakId: string;
    score: number;
    distanceMeters: number;
    nameSimilarity: number;
    elevationScore: number;
};

export type OneToOneMatch = {
    external: ExternalPeak;
    externalId: string;
    peakId: string;
    peakName: string;
    distanceMeters: number;
    score: number;
    nameSimilarity: number;
    secondBestScore: number | null;
    secondBestPeakId: string | null;
    /** For review items: null = pending, true = approved (link), false = rejected (skip or insert as new) */
    approved?: boolean | null;
};

export type ExternalMatchOutputs = {
    matchedHigh: OneToOneMatch[];
    matchedReview: OneToOneMatch[];
    unmatched: ExternalPeak[];
    skippedAlreadyLinked: ExternalPeak[];
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

const getExistingExternalIds = async (
    pool: Pool,
    source: string,
    externalIds: string[]
): Promise<Set<string>> => {
    if (externalIds.length === 0) return new Set();
    const chunkSize = 5000;
    const existing = new Set<string>();
    for (let i = 0; i < externalIds.length; i += chunkSize) {
        const chunk = externalIds.slice(i, i + chunkSize);
        const { rows } = await pool.query<{ external_id: string }>(
            `
            SELECT external_id
            FROM peak_external_ids
            WHERE source = $1
              AND external_id = ANY($2)
        `,
            [source, chunk]
        );
        for (const r of rows) existing.add(r.external_id);
    }
    return existing;
};

const findCandidates = async (
    pool: Pool,
    external: ExternalPeak,
    source: string,
    opts: MatchOptions
): Promise<PeakCandidate[]> => {
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
              AND pei.source = $4
        )
        ORDER BY distance_meters ASC
        LIMIT $5
    `,
        [external.lng, external.lat, opts.matchRadiusMeters, source, opts.maxCandidates]
    );
    return rows;
};

export const matchExternalPeaksOneToOne = async (
    pool: Pool,
    source: string,
    peaks: ExternalPeak[],
    options?: Partial<MatchOptions>
): Promise<ExternalMatchOutputs> => {
    const opts: MatchOptions = { ...DEFAULTS, ...(options ?? {}) };

    const externalIds = peaks
        .map((p) => p.externalId)
        .filter((x): x is string => typeof x === "string" && x.length > 0);
    const existing = await getExistingExternalIds(pool, source, externalIds);

    const toProcess: { peak: ExternalPeak; index: number }[] = [];
    const skippedAlreadyLinked: ExternalPeak[] = [];
    const skippedIndices = new Set<number>();

    peaks.forEach((p, idx) => {
        if (!p.externalId) {
            toProcess.push({ peak: p, index: idx });
            return;
        }
        if (existing.has(p.externalId)) {
            skippedAlreadyLinked.push(p);
            skippedIndices.add(idx);
            return;
        }
        toProcess.push({ peak: p, index: idx });
    });

    console.log(`\nExternal source: ${source}`);
    console.log(`Peaks: ${peaks.length}`);
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
        const candidates = await findCandidates(pool, peak, source, opts);
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

    const assignedPeakIds = [...assignedByExternal.values()].map((e) => e.peakId);
    const peakNameById = new Map<string, string>();
    if (assignedPeakIds.length > 0) {
        const { rows } = await pool.query<{ id: string; name: string }>(
            `SELECT id, name FROM peaks WHERE id = ANY($1)`,
            [assignedPeakIds]
        );
        for (const r of rows) peakNameById.set(r.id, r.name);
    }

    const matchedHigh: OneToOneMatch[] = [];
    const matchedReview: OneToOneMatch[] = [];
    const unmatched: ExternalPeak[] = [];

    for (let i = 0; i < peaks.length; i++) {
        if (skippedIndices.has(i)) continue;
        const external = peaks[i];
        const best = perExternalBest[i];
        const assigned = assignedByExternal.get(i);
        if (!assigned || !best.bestPeakId) {
            unmatched.push(external);
            continue;
        }

        const oneToOne: OneToOneMatch = {
            external,
            externalId: external.externalId ?? "",
            peakId: assigned.peakId,
            peakName: peakNameById.get(assigned.peakId) ?? "(unknown)",
            distanceMeters: assigned.distanceMeters,
            score: assigned.score,
            nameSimilarity: assigned.nameSimilarity,
            secondBestScore: best.secondBestScore,
            secondBestPeakId: best.secondBestPeakId,
        };

        const margin = best.secondBestScore !== null ? best.bestScore - best.secondBestScore : null;
        const autoAccept =
            assigned.score >= opts.autoAcceptMinScore &&
            assigned.distanceMeters <= opts.autoAcceptMaxDistanceMeters &&
            assigned.nameSimilarity >= opts.autoAcceptMinNameSimilarity &&
            (margin === null || margin >= opts.minMarginForAutoAccept);

        if (autoAccept) matchedHigh.push(oneToOne);
        else matchedReview.push(oneToOne);
    }

    console.log(`\n1:1 Matching results:`);
    console.log(`  matched-high:   ${matchedHigh.length}`);
    console.log(`  matched-review: ${matchedReview.length}`);
    console.log(`  unmatched:      ${unmatched.length}`);

    return { matchedHigh, matchedReview, unmatched, skippedAlreadyLinked };
};

export const writeExternalMatchOutputs = async (
    outputs: ExternalMatchOutputs,
    opts: { outDir: string; source: string }
): Promise<{
    matchedHigh: string;
    matchedReview: string;
    unmatched: string;
    skippedAlreadyLinked: string;
}> => {
    fs.mkdirSync(opts.outDir, { recursive: true });
    const pfx = `${opts.source}`;
    const matchedHighPath = path.join(opts.outDir, `${pfx}-matched-high.json`);
    const matchedReviewPath = path.join(opts.outDir, `${pfx}-matched-review.json`);
    const unmatchedPath = path.join(opts.outDir, `${pfx}-unmatched.json`);
    const skippedPath = path.join(opts.outDir, `${pfx}-skipped-already-linked.json`);

    fs.writeFileSync(matchedHighPath, JSON.stringify(outputs.matchedHigh, null, 2));
    
    // Add approved: null to review items so user can edit the file
    const reviewWithApproved = outputs.matchedReview.map((m) => ({
        ...m,
        approved: m.approved ?? null,
    }));
    fs.writeFileSync(matchedReviewPath, JSON.stringify(reviewWithApproved, null, 2));
    
    fs.writeFileSync(unmatchedPath, JSON.stringify(outputs.unmatched, null, 2));
    fs.writeFileSync(skippedPath, JSON.stringify(outputs.skippedAlreadyLinked, null, 2));

    return {
        matchedHigh: matchedHighPath,
        matchedReview: matchedReviewPath,
        unmatched: unmatchedPath,
        skippedAlreadyLinked: skippedPath,
    };
};

/** Load review JSON and filter by approved status */
export const loadReviewedMatches = (
    reviewFilePath: string
): { approved: OneToOneMatch[]; rejected: OneToOneMatch[]; pending: OneToOneMatch[] } => {
    if (!fs.existsSync(reviewFilePath)) {
        return { approved: [], rejected: [], pending: [] };
    }
    const data: OneToOneMatch[] = JSON.parse(fs.readFileSync(reviewFilePath, "utf-8"));
    const approved: OneToOneMatch[] = [];
    const rejected: OneToOneMatch[] = [];
    const pending: OneToOneMatch[] = [];
    for (const m of data) {
        if (m.approved === true) approved.push(m);
        else if (m.approved === false) rejected.push(m);
        else pending.push(m);
    }
    return { approved, rejected, pending };
};


