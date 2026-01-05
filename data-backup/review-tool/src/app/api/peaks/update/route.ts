import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { peakId, action } = body as {
            peakId: string;
            action: "accept" | "reject";
        };

        if (!peakId || !action) {
            return NextResponse.json(
                { error: "Missing peakId or action" },
                { status: 400 }
            );
        }

        const pool = await getPool();

        if (action === "accept") {
            // Accept: update location to snapped coords, update elevation
            await pool.query(
                `
                UPDATE peaks
                SET 
                    location_coords = snapped_coords::geography,
                    location_geom = snapped_coords::geometry,
                    elevation = snapped_elevation_m,
                    elevation_source = 'usgs_3dep',
                    needs_review = FALSE
                WHERE id = $1
                `,
                [peakId]
            );
        } else if (action === "reject") {
            // Reject: just clear the review flag, keep original coords
            await pool.query(
                `
                UPDATE peaks
                SET needs_review = FALSE
                WHERE id = $1
                `,
                [peakId]
            );
        } else {
            return NextResponse.json(
                { error: "Invalid action" },
                { status: 400 }
            );
        }

        return NextResponse.json({ success: true, peakId, action });
    } catch (error) {
        console.error("Error updating peak:", error);
        return NextResponse.json(
            { error: "Failed to update peak" },
            { status: 500 }
        );
    }
}

