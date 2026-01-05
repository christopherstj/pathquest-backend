import { Pool } from "pg";

let globalPool: Pool | undefined = undefined;

export async function getPool(): Promise<Pool> {
    if (globalPool) return globalPool;

    const user = process.env.PG_USER ?? "local-user";
    const password = process.env.PG_PASSWORD ?? "";
    const database = process.env.PG_DATABASE ?? "operations";
    const host = process.env.PG_HOST ?? "127.0.0.1";
    const port = parseInt(process.env.PG_PORT ?? "5432", 10);

    const pool = new Pool({
        user,
        password,
        database,
        host,
        port,
        max: 5,
    });

    // Smoke test
    await pool.query("SELECT 1");

    globalPool = pool;
    return pool;
}

export type ReviewPeak = {
    id: string;
    name: string;
    elevation: number | null;
    seed_lat: number;
    seed_lon: number;
    snapped_lat: number | null; // null if peak hasn't been snapped yet
    snapped_lon: number | null; // null if peak hasn't been snapped yet
    snapped_elevation_m: number | null;
    snapped_distance_m: number | null;
    snapped_confidence: number | null;
    snapped_dem_source: string | null;
    country: string | null;
    state: string | null;
    has_snapped: boolean; // true if snapped_coords exists
};

