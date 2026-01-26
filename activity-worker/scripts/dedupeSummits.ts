import { config } from "dotenv";
config(); // Load environment variables from .env file

import getCloudSqlConnection from "../helpers/getCloudSqlConnection";

/**
 * Finds and removes duplicate summits where the same user summited the same peak
 * within 10 minutes on the same activity.
 * 
 * This can happen when:
 * 1. Reprocessing with a slightly different algorithm detects a different timestamp
 * 2. GPS drift causes multiple detections near the same point
 * 
 * The script keeps the OLDEST summit (original detection) and removes duplicates.
 * 
 * Usage:
 *   DRY_RUN=true npx ts-node scripts/dedupeSummits.ts    # Preview changes
 *   npx ts-node scripts/dedupeSummits.ts                 # Actually delete duplicates
 * 
 * Environment variables:
 *   DRY_RUN - Set to "true" to preview without deleting (default: false)
 *   USER_ID - Filter to a specific user (optional)
 *   PEAK_ID - Filter to a specific peak (optional)
 */

const DRY_RUN = process.env.DRY_RUN === "true";
const USER_ID = process.env.USER_ID;
const PEAK_ID = process.env.PEAK_ID;

interface DuplicateGroup {
    activity_id: string;
    peak_id: string;
    user_id: string;
    summit_count: number;
    summits: Array<{
        id: string;
        timestamp: Date;
        has_notes: boolean;
        has_photos: boolean;
        confirmation_status: string | null;
    }>;
}

const main = async () => {
    const pool = await getCloudSqlConnection();

    console.log(`\n${"═".repeat(70)}`);
    if (DRY_RUN) {
        console.log(`🔬 SUMMIT DEDUPLICATION - DRY RUN MODE`);
        console.log(`   ⚠️  No database changes will be made!`);
    } else {
        console.log(`🧹 SUMMIT DEDUPLICATION`);
    }
    console.log(`${"═".repeat(70)}`);
    if (USER_ID) console.log(`   👤 User filter: ${USER_ID}`);
    if (PEAK_ID) console.log(`   🏔️  Peak filter: ${PEAK_ID}`);
    console.log(`${"═".repeat(70)}\n`);

    // Find activities with multiple summits of the same peak within 10 minutes
    let findDuplicatesQuery = `
        WITH summit_pairs AS (
            SELECT 
                ap1.id as id1,
                ap1.activity_id,
                ap1.peak_id,
                ap1.timestamp as ts1,
                ap2.id as id2,
                ap2.timestamp as ts2,
                a.user_id,
                p.name as peak_name,
                u.name as user_name,
                EXTRACT(EPOCH FROM (ap2.timestamp - ap1.timestamp)) as diff_seconds
            FROM activities_peaks ap1
            JOIN activities_peaks ap2 ON ap1.activity_id = ap2.activity_id 
                AND ap1.peak_id = ap2.peak_id 
                AND ap1.id < ap2.id  -- Avoid self-join and duplicates
            JOIN activities a ON ap1.activity_id = a.id
            JOIN peaks p ON ap1.peak_id = p.id
            JOIN users u ON a.user_id = u.id
            WHERE ABS(EXTRACT(EPOCH FROM (ap2.timestamp - ap1.timestamp))) <= 300  -- Within 5 minutes
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (USER_ID) {
        findDuplicatesQuery += ` AND a.user_id = $${paramIndex}`;
        params.push(USER_ID);
        paramIndex++;
    }

    if (PEAK_ID) {
        findDuplicatesQuery += ` AND ap1.peak_id = $${paramIndex}`;
        params.push(PEAK_ID);
        paramIndex++;
    }

    findDuplicatesQuery += `
        )
        SELECT DISTINCT activity_id, peak_id, user_id, peak_name, user_name, ts1 as first_timestamp
        FROM summit_pairs
        ORDER BY user_name, ts1 DESC
    `;

    console.log(`🔍 Finding duplicate summits (same peak within 10 minutes on same activity)...\n`);

    const { rows: duplicateActivities } = await pool.query(findDuplicatesQuery, params);

    if (duplicateActivities.length === 0) {
        console.log(`✅ No duplicate summits found!`);
        await pool.end();
        return;
    }

    console.log(`Found ${duplicateActivities.length} activity/peak combinations with duplicates\n`);

    let totalDuplicatesRemoved = 0;
    let totalPreserved = 0;

    for (const dup of duplicateActivities) {
        // Get all summits for this activity/peak combination
        const { rows: summits } = await pool.query(
            `SELECT 
                ap.id,
                ap.timestamp,
                ap.notes IS NOT NULL AND ap.notes != '' as has_notes,
                ap.confirmation_status,
                EXISTS(SELECT 1 FROM summit_photos sp WHERE sp.activities_peaks_id = ap.id) as has_photos
            FROM activities_peaks ap
            WHERE ap.activity_id = $1 AND ap.peak_id = $2
            ORDER BY ap.timestamp ASC`,
            [dup.activity_id, dup.peak_id]
        );

        const summitDate = new Date(dup.first_timestamp).toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });

        console.log(`\n${"─".repeat(60)}`);
        console.log(`📍 ${dup.peak_name} - ${summitDate}`);
        console.log(`   👤 User: ${dup.user_name} (${dup.user_id})`);
        console.log(`   🔗 Activity: ${dup.activity_id}`);
        console.log(`   Found ${summits.length} summits:`);

        // Group summits within 10-minute windows
        const windows: Array<typeof summits> = [];
        let currentWindow: typeof summits = [];
        let windowStart: Date | null = null;

        for (const summit of summits) {
            const ts = new Date(summit.timestamp);
            
            if (windowStart === null || (ts.getTime() - windowStart.getTime()) > 5 * 60 * 1000) {
                // Start a new window
                if (currentWindow.length > 0) {
                    windows.push(currentWindow);
                }
                currentWindow = [summit];
                windowStart = ts;
            } else {
                // Add to current window
                currentWindow.push(summit);
            }
        }
        if (currentWindow.length > 0) {
            windows.push(currentWindow);
        }

        // Process each window - keep the best summit, remove others
        for (const window of windows) {
            if (window.length <= 1) continue; // No duplicates in this window

            console.log(`\n   Window with ${window.length} summits:`);

            // Sort by priority: has_photos > user_confirmed > has_notes > oldest
            const sorted = [...window].sort((a, b) => {
                // Photos take highest priority
                if (a.has_photos && !b.has_photos) return -1;
                if (!a.has_photos && b.has_photos) return 1;
                
                // User confirmed takes next priority
                if (a.confirmation_status === 'user_confirmed' && b.confirmation_status !== 'user_confirmed') return -1;
                if (a.confirmation_status !== 'user_confirmed' && b.confirmation_status === 'user_confirmed') return 1;
                
                // Has notes takes next priority
                if (a.has_notes && !b.has_notes) return -1;
                if (!a.has_notes && b.has_notes) return 1;
                
                // Otherwise keep oldest (first detected)
                return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
            });

            const keep = sorted[0];
            const remove = sorted.slice(1);

            console.log(`   ✅ KEEP: ${keep.id}`);
            console.log(`      Timestamp: ${new Date(keep.timestamp).toISOString()}`);
            console.log(`      Photos: ${keep.has_photos ? 'YES' : 'no'} | Notes: ${keep.has_notes ? 'YES' : 'no'} | Status: ${keep.confirmation_status || 'auto'}`);

            for (const r of remove) {
                console.log(`   ❌ REMOVE: ${r.id}`);
                console.log(`      Timestamp: ${new Date(r.timestamp).toISOString()}`);
                console.log(`      Photos: ${r.has_photos ? 'YES' : 'no'} | Notes: ${r.has_notes ? 'YES' : 'no'} | Status: ${r.confirmation_status || 'auto'}`);
                
                const timeDiff = Math.abs(new Date(r.timestamp).getTime() - new Date(keep.timestamp).getTime()) / 1000;
                console.log(`      Time diff from kept: ${timeDiff.toFixed(0)}s`);
            }

            totalPreserved++;
            totalDuplicatesRemoved += remove.length;

            if (!DRY_RUN && remove.length > 0) {
                const idsToRemove = remove.map(r => r.id);
                await pool.query(
                    `DELETE FROM activities_peaks WHERE id = ANY($1::text[])`,
                    [idsToRemove]
                );
                console.log(`   🗑️  Deleted ${idsToRemove.length} duplicate(s)`);
            }
        }
    }

    console.log(`\n${"═".repeat(70)}`);
    console.log(`📊 SUMMARY`);
    console.log(`${"═".repeat(70)}`);
    console.log(`   Activity/peak combos with duplicates: ${duplicateActivities.length}`);
    console.log(`   Summits preserved: ${totalPreserved}`);
    console.log(`   Duplicates ${DRY_RUN ? 'that would be' : ''} removed: ${totalDuplicatesRemoved}`);
    console.log(`${"═".repeat(70)}`);

    if (DRY_RUN) {
        console.log(`\n⚠️  DRY RUN - No changes made. Run without DRY_RUN=true to delete duplicates.`);
    } else {
        console.log(`\n✅ Deduplication complete!`);
    }

    await pool.end();
};

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});

