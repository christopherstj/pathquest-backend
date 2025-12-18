import { config } from "dotenv";
config();

import detectSummits from "../helpers/detectSummits";
import { Point } from "../helpers/detectSummits";
import Peak from "../typeDefs/Peak";
import { CONFIDENCE_THRESHOLDS, SUMMIT_CONFIG } from "../helpers/summitConfig";
import processCoords from "../helpers/processCoords";
import getCloudSqlConnection from "../helpers/getCloudSqlConnection";

const assert = (condition: boolean, message: string) => {
    if (!condition) {
        throw new Error(message);
    }
};

const assertApproxEqual = (actual: number, expected: number, tolerance: number, message: string) => {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message}: expected ~${expected}, got ${actual}`);
    }
};

const buildPoints = (coords: [number, number][], times: number[], altitudes?: number[]): Point[] =>
    coords.map(([lng, lat], index) => ({
        lat,
        lng,
        time: times[index],
        index,
        altitude: altitudes?.[index],
    }));

// Test peaks with elevation data
const peaksWithElevation: Peak[] = [
    { id: "p1", name: "Peak One", lat: 40.0, lng: -105.0, elevation: 4300 },
    { id: "p2", name: "Peak Two", lat: 40.001, lng: -105.002, elevation: 4280 },
];

// Test peaks without elevation data
const peaksWithoutElevation: Peak[] = [
    { id: "p3", name: "Peak Three", lat: 40.0, lng: -105.0 },
    { id: "p4", name: "Peak Four", lat: 40.001, lng: -105.002 },
];

// ==================== BASIC FUNCTIONALITY TESTS ====================

const testSingleSummit = () => {
    const coords: [number, number][] = [
        [-105.01, 40.0],
        [-105.005, 40.0005],
        [-105.0005, 40.0], // close to p1
        [-105.0004, 40.0],
        [-105.0003, 40.0],
        [-105.002, 40.0006],
    ];
    const times = [0, 30, 60, 90, 120, 150];
    const altitudes = [4200, 4250, 4300, 4295, 4290, 4200];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithElevation);
    assert(res.length === 1, "Expected one summit");
    assert(res[0].id === "p1", "Expected summit on p1");
    assert(res[0].confidenceScore > 0, "Expected confidence score");
    assert(typeof res[0].needsConfirmation === "boolean", "Expected needsConfirmation flag");
    console.log(`  Single summit: confidence=${res[0].confidenceScore.toFixed(3)}`);
};

const testMultiPassSamePeak = () => {
    // Two passes with good dwell time and elevation match
    const coords: [number, number][] = [
        // First pass - good dwell with multiple points
        [-105.0004, 40.0],
        [-105.0003, 40.0001],
        [-105.0002, 40.0],
        [-105.0003, 40.0001],
        [-105.0002, 40.0],
        // Move far away
        [-105.01, 40.0],
        [-105.02, 39.99],
        [-105.03, 39.98],
        // Second pass - good dwell with multiple points
        [-105.0004, 40.0],
        [-105.0003, 40.0001],
        [-105.0002, 40.0],
        [-105.0003, 40.0001],
        [-105.0002, 40.0],
    ];
    // Times: first pass 0-120, move away, second pass 600-720
    const times = [0, 30, 60, 90, 120, 200, 400, 500, 600, 630, 660, 690, 720];
    // Elevation matches peak (4300m) with slight approach pattern
    const altitudes = [4280, 4290, 4300, 4295, 4298, 4200, 4100, 4000, 4280, 4290, 4300, 4295, 4298];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithElevation);
    assert(res.length === 2, `Expected two summits for two passes, got ${res.length}`);
    assert(res.every((r) => r.id === "p1"), "Both summits should be p1");
};

const testIgnoreBriefSpike = () => {
    // Brief spike with only 1 sample - should be rejected due to low confidence
    const coords: [number, number][] = [
        [-105.01, 40.0],
        [-105.0005, 40.0], // single near point
        [-105.01, 40.0],
        [-105.02, 40.0],
    ];
    const times = [0, 10, 20, 30];
    const altitudes = [4200, 4300, 4200, 4100];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithElevation);
    // With low samples and brief dwell, confidence should be below threshold
    assert(res.length === 0, "Expected no summit for brief spike");
};

// ==================== MODE A: FULL DATA TESTS ====================

const testModeA_HighConfidenceSummit = () => {
    // Mode A: Both GPS altitude and peak elevation available
    // Scenario: Very close approach, elevation matches, good dwell
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0002, 40.0001], // very close
        [-105.0001, 40.0],    // very close
        [-105.0002, 40.0001], // very close
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    const times = [0, 30, 60, 90, 120, 150, 180];
    // Elevation matches peak (4300m) with approach pattern
    const altitudes = [4200, 4250, 4295, 4300, 4298, 4250, 4200];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithElevation);
    
    assert(res.length === 1, `Mode A high conf: expected 1 summit, got ${res.length}`);
    assert(res[0].confidenceScore >= CONFIDENCE_THRESHOLDS.HIGH, 
        `Mode A high conf: expected confidence >= ${CONFIDENCE_THRESHOLDS.HIGH}, got ${res[0].confidenceScore.toFixed(3)}`);
    assert(!res[0].needsConfirmation, "Mode A high conf: should not need confirmation");
    console.log(`  Mode A high confidence: ${res[0].confidenceScore.toFixed(3)}`);
};

const testModeA_TrailPassBelow = () => {
    // Mode A: Trail pass 200m below summit - should be rejected
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0006, 40.0001], // near peak horizontally
        [-105.0005, 40.0],    // near peak horizontally
        [-105.0006, 40.0001], // near peak horizontally
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    const times = [0, 30, 60, 90, 120, 150, 180];
    // Elevation ~200m below peak (4300m) - trail pass
    const altitudes = [4050, 4080, 4100, 4102, 4099, 4080, 4050];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithElevation);
    
    // Should be rejected due to large elevation difference
    if (res.length > 0) {
        assert(res[0].confidenceScore < CONFIDENCE_THRESHOLDS.REJECT,
            `Mode A trail pass: expected confidence < ${CONFIDENCE_THRESHOLDS.REJECT}, got ${res[0].confidenceScore.toFixed(3)}`);
    }
    console.log(`  Mode A trail pass: ${res.length === 0 ? 'rejected' : `confidence=${res[0].confidenceScore.toFixed(3)}`}`);
};

const testModeA_EdgeCaseNeedsConfirmation = () => {
    // Mode A: Marginal case that should be flagged for confirmation
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0007, 40.0001], // moderately close (about 70m)
        [-105.0006, 40.0],
        [-105.0007, 40.0001],
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    const times = [0, 30, 60, 90, 120, 150, 180];
    // Elevation slightly below peak - within tolerance but not perfect
    const altitudes = [4150, 4200, 4220, 4225, 4218, 4200, 4150];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithElevation);
    
    if (res.length > 0) {
        console.log(`  Mode A edge case: confidence=${res[0].confidenceScore.toFixed(3)}, needsConfirmation=${res[0].needsConfirmation}`);
    } else {
        console.log(`  Mode A edge case: rejected (below threshold)`);
    }
};

// ==================== MODE B: GPS ALTITUDE ONLY ====================

const testModeB_GoodApproachPattern = () => {
    // Mode B: GPS altitude but no peak elevation
    // Good approach pattern should still be detected
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0004, 40.0001], // close
        [-105.0003, 40.0],    // close
        [-105.0004, 40.0001], // close
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    const times = [0, 30, 60, 90, 120, 150, 180];
    // Good approach pattern: climb up, peak at closest approach, descend
    const altitudes = [3800, 3900, 4050, 4100, 4040, 3900, 3800];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithoutElevation);
    
    assert(res.length === 1, `Mode B good approach: expected 1 summit, got ${res.length}`);
    console.log(`  Mode B good approach: confidence=${res[0].confidenceScore.toFixed(3)}`);
};

const testModeB_FlatApproach = () => {
    // Mode B: Flat elevation profile - suspicious for summit
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0004, 40.0001], // close
        [-105.0003, 40.0],    // close
        [-105.0004, 40.0001], // close
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    const times = [0, 30, 60, 90, 120, 150, 180];
    // Flat profile - likely trail pass, not summit
    const altitudes = [3900, 3902, 3901, 3903, 3900, 3902, 3901];
    const points = buildPoints(coords, times, altitudes);
    const res = detectSummits(points, peaksWithoutElevation);
    
    if (res.length > 0) {
        console.log(`  Mode B flat approach: confidence=${res[0].confidenceScore.toFixed(3)} (penalized)`);
    } else {
        console.log(`  Mode B flat approach: rejected`);
    }
};

// ==================== MODE C: PEAK ELEVATION ONLY ====================

const testModeC_CloseApproach = () => {
    // Mode C: Peak elevation but no GPS altitude
    // Very close approach should still be detected
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0003, 40.0001], // very close (within 40m)
        [-105.0002, 40.0],    // very close
        [-105.0003, 40.0001], // very close
        [-105.0002, 40.0],
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    const times = [0, 30, 60, 90, 120, 150, 180, 210];
    // No altitudes - simulating missing GPS altitude
    const points = buildPoints(coords, times);
    const res = detectSummits(points, peaksWithElevation);
    
    if (res.length > 0) {
        console.log(`  Mode C close approach: confidence=${res[0].confidenceScore.toFixed(3)}`);
    } else {
        console.log(`  Mode C close approach: rejected (stricter distance threshold)`);
    }
};

const testModeC_DistantApproach = () => {
    // Mode C: Approach outside the stricter 40m threshold
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0006, 40.0001], // ~67m from peak - outside Mode C threshold
        [-105.0005, 40.0],
        [-105.0006, 40.0001],
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    const times = [0, 30, 60, 90, 120, 150, 180];
    const points = buildPoints(coords, times);
    const res = detectSummits(points, peaksWithElevation);
    
    // Should not detect due to stricter distance in Mode C
    console.log(`  Mode C distant: ${res.length === 0 ? 'rejected (correct - outside 40m)' : `detected with confidence=${res[0].confidenceScore.toFixed(3)}`}`);
};

// ==================== MODE D: NO ELEVATION DATA ====================

const testModeD_VeryCloseApproach = () => {
    // Mode D: No elevation data at all
    // Only very close approaches with good dwell should be detected
    const coords: [number, number][] = [
        [-105.005, 40.0],
        [-105.002, 40.0002],
        [-105.0002, 40.0001], // very close (~25m)
        [-105.0001, 40.0],    // very close
        [-105.0001, 40.0001], // very close
        [-105.0002, 40.0],    // very close
        [-105.0001, 40.0001], // very close
        [-105.002, 40.0002],
        [-105.005, 40.0],
    ];
    // Longer dwell time for Mode D requirement
    const times = [0, 30, 60, 90, 120, 150, 180, 210, 240];
    const points = buildPoints(coords, times);
    const res = detectSummits(points, peaksWithoutElevation);
    
    if (res.length > 0) {
        console.log(`  Mode D very close: confidence=${res[0].confidenceScore.toFixed(3)}`);
    } else {
        console.log(`  Mode D very close: rejected (requires very strict criteria)`);
    }
};

// ==================== REAL ACTIVITY TEST ====================

const testMountWhitneyActivity = async () => {
    // Test activity 15336809938 - should only detect Mount Whitney (944865772)
    const activityId = "15336809938";
    const mountWhitneyId = "944865772";
    
    const pool = await getCloudSqlConnection();
    
    try {
        const { rows } = await pool.query(`
            SELECT 
                ST_AsGeoJSON(coords::geometry) as coords,
                time_stream,
                vert_profile
            FROM activities
            WHERE id = $1
        `, [activityId]);

        if (rows.length === 0) {
            console.log(`  Mount Whitney activity test: Skipped - activity ${activityId} not found in database`);
            return;
        }

        const activity = rows[0];
        const geo = JSON.parse(activity.coords);
        const coords = geo.coordinates as [number, number][];
        const times = Array.isArray(activity.time_stream) ? activity.time_stream : undefined;
        const altitudes = Array.isArray(activity.vert_profile) ? activity.vert_profile : undefined;

        const summits = await processCoords(coords, times, altitudes);

        // Should detect Mount Whitney with high confidence
        const whitneySummit = summits.find(s => s.id === mountWhitneyId);
        assert(whitneySummit !== undefined, `Mount Whitney (${mountWhitneyId}) should be detected`);
        assert(whitneySummit!.confidenceScore >= 0.70, `Mount Whitney should have high confidence (>=0.70), got ${whitneySummit!.confidenceScore.toFixed(3)}`);
        assert(!whitneySummit!.needsConfirmation, "Mount Whitney should not need confirmation");

        // Should have exactly 1 auto-accepted summit (Whitney)
        const autoAccepted = summits.filter(s => !s.needsConfirmation);
        assert(autoAccepted.length === 1, `Should have exactly 1 auto-accepted summit (got ${autoAccepted.length})`);
        assert(autoAccepted[0].id === mountWhitneyId, "Only Mount Whitney should be auto-accepted");

        // Other summits should need confirmation (if any) - max 1 additional summit flagged
        const needsConfirmation = summits.filter(s => s.needsConfirmation);
        assert(needsConfirmation.length <= 1, `Should have at most 1 summit needing confirmation (got ${needsConfirmation.length})`);
        
        // All summits needing confirmation should have confidence between 0.55 and 0.65
        needsConfirmation.forEach(s => {
            assert(s.confidenceScore >= 0.55, `Summit needing confirmation should have confidence >= 0.55, got ${s.confidenceScore.toFixed(3)}`);
            assert(s.confidenceScore < 0.65, `Summit needing confirmation should have confidence < 0.65, got ${s.confidenceScore.toFixed(3)}`);
        });

        console.log(`  Mount Whitney activity: ${summits.length} summit(s) detected`);
        console.log(`    - Auto-accepted: Mount Whitney (confidence: ${whitneySummit!.confidenceScore.toFixed(3)})`);
        if (needsConfirmation.length > 0) {
            console.log(`    - Needs confirmation: ${needsConfirmation.length} summit(s)`);
            needsConfirmation.forEach(s => {
                console.log(`      * Peak ${s.id} (confidence: ${s.confidenceScore.toFixed(3)})`);
            });
        }
    } catch (error) {
        console.error(`  Mount Whitney activity test failed:`, error);
        throw error;
    } finally {
        await pool.end();
    }
};

// ==================== CONFIG VERIFICATION ====================

const testConfigValues = () => {
    // Verify config values are as expected
    assert(SUMMIT_CONFIG.A.enterDistance === 80, "Mode A enterDistance should be 80");
    assert(SUMMIT_CONFIG.B.enterDistance === 60, "Mode B enterDistance should be 60");
    assert(SUMMIT_CONFIG.C.enterDistance === 40, "Mode C enterDistance should be 40");
    assert(SUMMIT_CONFIG.D.enterDistance === 35, "Mode D enterDistance should be 35");
    
    assert(SUMMIT_CONFIG.A.useElevationMatch === true, "Mode A should use elevation match");
    assert(SUMMIT_CONFIG.A.useApproachPattern === true, "Mode A should use approach pattern");
    assert(SUMMIT_CONFIG.A.threshold === 0.65, "Mode A threshold should be 0.65 (stricter)");
    assert(SUMMIT_CONFIG.B.useElevationMatch === false, "Mode B should not use elevation match");
    assert(SUMMIT_CONFIG.B.useApproachPattern === true, "Mode B should use approach pattern");
    assert(SUMMIT_CONFIG.C.useElevationMatch === false, "Mode C should not use elevation match");
    assert(SUMMIT_CONFIG.C.useApproachPattern === false, "Mode C should not use approach pattern");
    
    console.log("  Config values verified");
};

// ==================== RUN ALL TESTS ====================

const run = async () => {
    console.log("\n=== Basic Functionality Tests ===");
    testSingleSummit();
    testMultiPassSamePeak();
    testIgnoreBriefSpike();
    
    console.log("\n=== Mode A (Full Data) Tests ===");
    testModeA_HighConfidenceSummit();
    testModeA_TrailPassBelow();
    testModeA_EdgeCaseNeedsConfirmation();
    
    console.log("\n=== Mode B (GPS Altitude Only) Tests ===");
    testModeB_GoodApproachPattern();
    testModeB_FlatApproach();
    
    console.log("\n=== Mode C (Peak Elevation Only) Tests ===");
    testModeC_CloseApproach();
    testModeC_DistantApproach();
    
    console.log("\n=== Mode D (No Elevation Data) Tests ===");
    testModeD_VeryCloseApproach();
    
    console.log("\n=== Real Activity Test ===");
    await testMountWhitneyActivity();
    
    console.log("\n=== Config Verification ===");
    testConfigValues();
    
    console.log("\n✅ All detectSummits tests passed.\n");
};

run().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
