import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { peakId } = body as { peakId: string };

        if (!peakId) {
            return NextResponse.json(
                { error: "Missing peakId" },
                { status: 400 }
            );
        }

        const pool = await getPool();

        // First delete from junction tables to avoid FK violations
        await pool.query(
            `DELETE FROM peak_external_ids WHERE peak_id = $1`,
            [peakId]
        );

        await pool.query(
            `DELETE FROM peaks_public_lands WHERE peak_id = $1`,
            [peakId]
        );

        await pool.query(
            `DELETE FROM peaks_challenges WHERE peak_id = $1`,
            [peakId]
        );

        // Then delete the peak itself
        const result = await pool.query(
            `DELETE FROM peaks WHERE id = $1 RETURNING id, name`,
            [peakId]
        );

        if (result.rowCount === 0) {
            return NextResponse.json(
                { error: "Peak not found" },
                { status: 404 }
            );
        }

        console.log(`Deleted peak: ${result.rows[0].name} (${peakId})`);

        return NextResponse.json({
            success: true,
            peakId,
            deleted: result.rows[0],
        });
    } catch (error) {
        console.error("Error deleting peak:", error);
        return NextResponse.json(
            { error: "Failed to delete peak" },
            { status: 500 }
        );
    }
}

