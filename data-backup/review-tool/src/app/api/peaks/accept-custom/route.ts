import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { peakId, lat, lon } = body as {
            peakId: string;
            lat: number;
            lon: number;
        };

        if (!peakId || lat == null || lon == null) {
            return NextResponse.json(
                { error: "Missing peakId, lat, or lon" },
                { status: 400 }
            );
        }

        const pool = await getPool();

        // Update location to custom coords (no elevation since we don't know it)
        await pool.query(
            `
            UPDATE peaks
            SET 
                location_coords = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                location_geom = ST_SetSRID(ST_MakePoint($2, $1), 4326),
                snapped_coords = ST_SetSRID(ST_MakePoint($2, $1), 4326),
                snapped_distance_m = ST_Distance(
                    COALESCE(seed_coords, location_geom)::geography,
                    ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
                ),
                snapped_dem_source = 'manual',
                needs_review = FALSE
            WHERE id = $3
            `,
            [lat, lon, peakId]
        );

        return NextResponse.json({
            success: true,
            peakId,
            lat,
            lon,
        });
    } catch (error) {
        console.error("Error accepting custom coords:", error);
        return NextResponse.json(
            { error: "Failed to update peak" },
            { status: 500 }
        );
    }
}

