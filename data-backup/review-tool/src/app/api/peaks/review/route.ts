import { NextRequest, NextResponse } from "next/server";
import { getPool, ReviewPeak } from "@/lib/db";

// PostgreSQL returns numeric types as strings - parse them to numbers
function parseNum(val: unknown): number | null {
    if (val == null) return null;
    const n = typeof val === "string" ? parseFloat(val) : Number(val);
    return isNaN(n) ? null : n;
}

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const limit = parseInt(searchParams.get("limit") ?? "50", 10);
        const offset = parseInt(searchParams.get("offset") ?? "0", 10);

        const pool = await getPool();

        // Get total count
        const countResult = await pool.query<{ count: string }>(
            `SELECT COUNT(*) as count FROM peaks WHERE needs_review = TRUE`
        );
        const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

        // Get peaks needing review (includes both snapped and non-snapped peaks)
        const result = await pool.query(
            `
            SELECT 
                p.id,
                p.name,
                p.elevation,
                ST_Y(COALESCE(p.seed_coords, p.location_geom)::geometry) as seed_lat,
                ST_X(COALESCE(p.seed_coords, p.location_geom)::geometry) as seed_lon,
                ST_Y(p.snapped_coords::geometry) as snapped_lat,
                ST_X(p.snapped_coords::geometry) as snapped_lon,
                p.snapped_elevation_m,
                p.snapped_distance_m,
                p.snapped_dem_source,
                p.country,
                p.state,
                p.snapped_coords IS NOT NULL as has_snapped
            FROM peaks p
            WHERE p.needs_review = TRUE
            ORDER BY p.elevation DESC NULLS LAST
            LIMIT $1 OFFSET $2
            `,
            [limit, offset]
        );

        const peaks: ReviewPeak[] = result.rows.map((row) => ({
            id: String(row.id),
            name: String(row.name ?? "Unknown"),
            elevation: parseNum(row.elevation),
            seed_lat: parseNum(row.seed_lat) ?? 0,
            seed_lon: parseNum(row.seed_lon) ?? 0,
            snapped_lat: parseNum(row.snapped_lat),
            snapped_lon: parseNum(row.snapped_lon),
            snapped_elevation_m: parseNum(row.snapped_elevation_m),
            snapped_distance_m: parseNum(row.snapped_distance_m),
            snapped_confidence: null, // We don't have this column yet
            snapped_dem_source: row.snapped_dem_source ? String(row.snapped_dem_source) : null,
            country: row.country ? String(row.country) : null,
            state: row.state ? String(row.state) : null,
            has_snapped: row.has_snapped === true,
        }));

        return NextResponse.json({ peaks, total });
    } catch (error) {
        console.error("Error fetching review peaks:", error);
        return NextResponse.json(
            { error: "Failed to fetch peaks" },
            { status: 500 }
        );
    }
}

