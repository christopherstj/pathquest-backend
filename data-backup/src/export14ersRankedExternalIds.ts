import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://www.14ers.com";

type RankedRow = {
    externalId: string; // full URL to peak page
    fourteenersPeakId: string; // numeric id from /peaks/<id>/
    name: string;
    coRank: number | null;
    thirteenRank: number | null;
    elevationFeet: number | null;
    range: string;
};

const parseIntOrNull = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    const n = Number.parseInt(t.replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
};

const parseElevationFeetOrNull = (s: string): number | null => {
    const m = s.match(/([\d,]+)/);
    if (!m) return null;
    const n = Number.parseInt(m[1].replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : null;
};

export default async function export14ersRankedExternalIds(): Promise<void> {
    const outDir = process.env.FOURTEENERS_OUT_DIR ?? ".";
    const outRankedOnly = process.env.FOURTEENERS_RANKED_ONLY !== "false"; // default true

    console.log(`\nFetching 14ers.com 13ers list page (rank metadata only)...`);
    const resp = await fetch(`${BASE_URL}/13ers`, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
    });
    if (!resp.ok) {
        throw new Error(`Failed to fetch list page: ${resp.status} ${resp.statusText}`);
    }
    const html = await resp.text();
    const $ = cheerio.load(html);

    const rows: RankedRow[] = [];

    $("table tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length < 6) return;

        const peakCell = cells.eq(0);
        const link = peakCell.find("a").first();
        const href = link.attr("href");
        if (!href || !href.startsWith("/peaks/")) return;

        const hrefMatch = href.match(/^\/peaks\/(\d+)\//);
        if (!hrefMatch) return;
        const fourteenersPeakId = hrefMatch[1];

        let name = link.find("span").text().trim() || link.text().trim();
        name = name.replace(/^"|"$/g, "").trim();

        const coRank = parseIntOrNull(cells.eq(2).text());
        const thirteenRank = parseIntOrNull(cells.eq(3).text());
        const elevationFeet = parseElevationFeetOrNull(cells.eq(4).text());
        const range = cells.eq(5).text().trim();

        const externalId = `${BASE_URL}${href}`;

        if (outRankedOnly && thirteenRank === null) return;

        rows.push({
            externalId,
            fourteenersPeakId,
            name,
            coRank,
            thirteenRank,
            elevationFeet,
            range,
        });
    });

    fs.mkdirSync(outDir, { recursive: true });

    const rankedExternalIdsPath = path.join(outDir, "14ers-ranked-external-ids.json");
    const rankedMetaPath = path.join(outDir, "14ers-ranked-meta.json");

    fs.writeFileSync(rankedExternalIdsPath, JSON.stringify(rows.map((r) => r.externalId), null, 2));
    fs.writeFileSync(rankedMetaPath, JSON.stringify(rows, null, 2));

    console.log(`\nExported ${rows.length} ${outRankedOnly ? "ranked" : "all"} entries:`); // eslint-disable-line no-console
    console.log(`  - ${rankedExternalIdsPath}`);
    console.log(`  - ${rankedMetaPath}`);
}


