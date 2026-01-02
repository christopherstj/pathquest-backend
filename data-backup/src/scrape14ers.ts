import * as cheerio from "cheerio";
import { ExternalPeak } from "../typeDefs/ChallengeImport";

const BASE_URL = "https://www.14ers.com";

type ScrapeOptions = {
    maxPeaks?: number;
    sleepMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scrape the 13ers list page to get all peak URLs
 */
const scrape13ersListPage = async (): Promise<{
    name: string;
    url: string;
    peakId: string;
    elevationFeet: number | null;
    elevationText: string;
    range: string;
    coRank: number | null;
    thirteenRank: number | null;
}[]> => {
    console.log(`\nFetching 14ers.com 13ers list page...`);
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

    const peaks: {
        name: string;
        url: string;
        peakId: string;
        elevationFeet: number | null;
        elevationText: string;
        range: string;
        coRank: number | null;
        thirteenRank: number | null;
    }[] = [];

    // Parse table rows - each row has: Peak, Climbed, CO Rank, 13er Rank, Elevation, Range, Routes, Member Ascents
    $("table tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length < 6) return; // Skip header or malformed rows

        const peakCell = cells.eq(0);
        const link = peakCell.find("a").first();
        const href = link.attr("href");
        if (!href || !href.startsWith("/peaks/")) return;

        // Get peak name (might be in span)
        let name = link.find("span").text().trim() || link.text().trim();
        // Clean up name - remove quotes around nicknames
        name = name.replace(/^"|"$/g, "").trim();

        const hrefMatch = href.match(/^\/peaks\/(\d+)\//);
        if (!hrefMatch) return;
        const peakId = hrefMatch[1];

        const coRankText = cells.eq(2).text().trim();
        const thirteenRankText = cells.eq(3).text().trim();
        const coRank = coRankText ? Number.parseInt(coRankText.replace(/[^\d]/g, ""), 10) : null;
        const thirteenRank = thirteenRankText ? Number.parseInt(thirteenRankText.replace(/[^\d]/g, ""), 10) : null;

        const elevationText = cells.eq(4).text().trim(); // e.g., "13,997'"
        const elevMatch = elevationText.match(/([\d,]+)/);
        const elevationFeet = elevMatch ? Number.parseInt(elevMatch[1].replace(/,/g, ""), 10) : null;

        const range = cells.eq(5).text().trim();

        peaks.push({
            name,
            url: `${BASE_URL}${href}`,
            peakId,
            elevationFeet: Number.isFinite(elevationFeet) ? elevationFeet : null,
            elevationText,
            range,
            coRank: Number.isFinite(coRank as number) ? coRank : null,
            thirteenRank: Number.isFinite(thirteenRank as number) ? thirteenRank : null,
        });
    });

    console.log(`Found ${peaks.length} peaks in list`);
    return peaks;
};

/**
 * Extract coordinates from an individual peak page
 */
const extractCoordsFromPeakPage = async (
    url: string
): Promise<{ lat: number; lng: number } | null> => {
    const resp = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
    });
    if (!resp.ok) {
        console.warn(`Failed to fetch ${url}: ${resp.status}`);
        return null;
    }
    const html = await resp.text();

    // IMPORTANT: pages contain many unrelated lat/lon params (weather widgets, etc).
    // We must extract the specific Lat/Lon field for the peak.
    const $ = cheerio.load(html);

    // 1) Best: find the labeled "Lat/Lon" row and parse its displayed text.
    // Example HTML (observed):
    // Lat/Lon</span><span class="value"><a ...>39.11404, -106.49386</a></span>
    const latLonLabel = $("span.label")
        .filter((_, el) => $(el).text().trim().toLowerCase() === "lat/lon")
        .first();
    if (latLonLabel.length) {
        const valueText = latLonLabel.parent().find("span.value").first().text().trim();
        const m = valueText.match(/([0-9]+\.[0-9]+)\s*,\s*(-[0-9]+\.[0-9]+)/);
        if (m) {
            const lat = parseFloat(m[1]);
            const lng = parseFloat(m[2]);
            if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= 36 && lat <= 42 && lng >= -110 && lng <= -100) {
                return { lat, lng };
            }
        }
    }

    // 2) Fallback: regex anchored near the Lat/Lon label in raw HTML
    const anchored = html.match(/Lat\/Lon<\/span>\s*<span[^>]*class="value"[^>]*>[\s\S]{0,250}?([0-9]+\.[0-9]+)\s*,\s*(-[0-9]+\.[0-9]+)/i);
    if (anchored) {
        const lat = parseFloat(anchored[1]);
        const lng = parseFloat(anchored[2]);
        if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= 36 && lat <= 42 && lng >= -110 && lng <= -100) {
            return { lat, lng };
        }
    }

    // 3) Last resort: look for the hiking-course link used by the Lat/Lon row.
    // This typically includes: lat=<lat>&startlon=<lon>&hc=yes">lat, lon
    const hc = html.match(/lat=([0-9]+\.[0-9]+)&startlon=(-[0-9]+\.[0-9]+)&hc=yes[^>]*>\s*\1\s*,\s*\2\s*</i);
    if (hc) {
        const lat = parseFloat(hc[1]);
        const lng = parseFloat(hc[2]);
        if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= 36 && lat <= 42 && lng >= -110 && lng <= -100) {
            return { lat, lng };
        }
    }

    return null;
};

/**
 * Parse elevation string like "13,997'" to meters
 */
const parseElevationToMeters = (elevStr: string): number => {
    const match = elevStr.match(/([\d,]+)/);
    if (!match) return 0;
    const feet = parseInt(match[1].replace(/,/g, ""), 10);
    if (!Number.isFinite(feet)) return 0;
    return feet * 0.3048;
};

/**
 * Main scraper function
 */
export const scrape14ersListPage = async (
    options: ScrapeOptions = {}
): Promise<ExternalPeak[]> => {
    const sleepMs = options.sleepMs ?? 300;

    // Get list of all peaks
    const peakList = await scrape13ersListPage();

    const maxPeaks = options.maxPeaks && options.maxPeaks > 0 ? options.maxPeaks : peakList.length;
    const selected = peakList.slice(0, maxPeaks);

    const peaks: ExternalPeak[] = [];
    let noCoords = 0;
    const coordKeyCounts = new Map<string, number>();

    for (let i = 0; i < selected.length; i++) {
        const p = selected[i];
        console.log(`Fetching peak ${i + 1}/${selected.length}: ${p.name}`);

        const coords = await extractCoordsFromPeakPage(p.url);
        if (!coords) {
            console.warn(`  No coordinates found for: ${p.name}`);
            noCoords++;
            await sleep(sleepMs);
            continue;
        }

        const elevation = parseElevationToMeters(p.elevationText);

        peaks.push({
            name: p.name,
            lat: coords.lat,
            lng: coords.lng,
            elevation,
            externalSource: "14ers",
            externalId: p.url,
            sourceUrl: p.url,
            peakId: p.peakId,
            coRank: p.coRank ?? undefined,
            thirteenRank: p.thirteenRank ?? undefined,
            range: p.range || undefined,
            elevationFeet: p.elevationFeet ?? undefined,
        });

        const key = `${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`;
        coordKeyCounts.set(key, (coordKeyCounts.get(key) ?? 0) + 1);

        await sleep(sleepMs);
    }

    console.log(`\nScraped ${peaks.length} peaks with coordinates from 14ers.com`);
    if (noCoords > 0) {
        console.log(`${noCoords} peaks had no coordinates found`);
    }
    const maxDup = Math.max(0, ...[...coordKeyCounts.values()]);
    if (peaks.length >= 10 && maxDup >= Math.ceil(peaks.length * 0.3)) {
        console.warn(
            `WARNING: many peaks share identical coords (max duplicates: ${maxDup}/${peaks.length}). ` +
                `This usually means we extracted a non-peak widget coordinate.`
        );
    }
    return peaks;
};

export default scrape14ersListPage;

