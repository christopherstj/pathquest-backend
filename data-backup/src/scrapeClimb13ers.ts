import * as cheerio from "cheerio";
import { ExternalPeak } from "../typeDefs/ChallengeImport";

const DEFAULT_BASE_URL = "https://www.climb13ers.com";

type ScrapeOptions = {
    baseUrl?: string;
    maxPeaks?: number;
    sleepMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const absolutize = (baseUrl: string, href: string): string => {
    try {
        return new URL(href, baseUrl).toString();
    } catch {
        return href;
    }
};

const isLikelyBlockedHtml = (html: string): boolean => {
    const t = html.toLowerCase();
    return (
        t.includes("cloudflare") &&
        (t.includes("attention required") ||
            t.includes("checking your browser") ||
            t.includes("cf-chl") ||
            t.includes("cf-browser-verification"))
    );
};

const parseCoordsFromUrl = (url: string): { lat: number; lng: number } | null => {
    // Google Maps: ...?q=lat,lng
    const qMatch = url.match(/[?&]q=([-\d.]+),([-\d.]+)/);
    if (qMatch) return { lat: Number(qMatch[1]), lng: Number(qMatch[2]) };

    // OpenStreetMap: ...?mlat=...&mlon=...
    const mlat = url.match(/[?&]mlat=([-\d.]+)/);
    const mlon = url.match(/[?&]mlon=([-\d.]+)/);
    if (mlat && mlon) return { lat: Number(mlat[1]), lng: Number(mlon[1]) };

    // CalTopo commonly uses ll=lat,lon or marker=lat,lon (sometimes multiple markers).
    const ll = url.match(/[?&]ll=([-\d.]+),([-\d.]+)/i);
    if (ll) return { lat: Number(ll[1]), lng: Number(ll[2]) };
    const marker = url.match(/[?&](?:marker|m)=([-\d.]+),([-\d.]+)/i);
    if (marker) return { lat: Number(marker[1]), lng: Number(marker[2]) };

    // Some CalTopo/other map links use lat/lon params separately.
    const latParam = url.match(/[?&]lat=([-\d.]+)/i);
    const lonParam = url.match(/[?&](?:lon|lng|long)=([-\d.]+)/i);
    if (latParam && lonParam) return { lat: Number(latParam[1]), lng: Number(lonParam[1]) };

    return null;
};

/**
 * Convert DMS (degrees, minutes, seconds) to decimal degrees.
 */
const dmsToDecimal = (deg: number, min: number, sec: number, dir: string): number => {
    let decimal = deg + min / 60 + sec / 3600;
    if (dir === "S" || dir === "W") decimal = -decimal;
    return decimal;
};

const parseCoordsFromText = (text: string): { lat: number; lng: number } | null => {
    // Normalize HTML entities that Climb13ers uses:
    // &#039; or &apos; -> '
    // &quot; -> "
    // ° stays as °
    const pageText = text
        .replace(/&#039;|&apos;/g, "'")
        .replace(/&quot;/g, '"');

    // DMS format: N 37° 39' 37.23", W 107° 35' 06.63"
    // Also match without symbols: N 37 39 37.23, W 107 35 06.63
    const dmsPatterns = [
        // "N 37° 39' 37.23", W 107° 35' 06.63"" (with degree/minute/second symbols)
        /([NS])\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?\s*[,\s]+\s*([EW])\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?/gi,
        // Reversed: 37° 39' 37.23" N, 107° 35' 06.63" W
        /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?\s*([NS])\s*[,\s]+\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?\s*([EW])/gi,
    ];

    for (const p of dmsPatterns) {
        const matches = [...pageText.matchAll(p)];
        for (const m of matches) {
            let lat: number;
            let lng: number;
            if (m[1].match(/[NS]/i)) {
                // Format: N 37° 39' 37.23", W 107° 35' 06.63"
                lat = dmsToDecimal(Number(m[2]), Number(m[3]), Number(m[4]), m[1].toUpperCase());
                lng = dmsToDecimal(Number(m[6]), Number(m[7]), Number(m[8]), m[5].toUpperCase());
            } else {
                // Format: 37° 39' 37.23" N, 107° 35' 06.63" W
                lat = dmsToDecimal(Number(m[1]), Number(m[2]), Number(m[3]), m[4].toUpperCase());
                lng = dmsToDecimal(Number(m[5]), Number(m[6]), Number(m[7]), m[8].toUpperCase());
            }
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
            return { lat, lng };
        }
    }

    // Fallback: decimal degree patterns
    const decimalPatterns = [
        // 39.1234, -105.1234
        /([-]?\d{1,3}\.\d{3,})[\s,]+([-]?\d{1,3}\.\d{3,})/g,
        // 39.1234 N 105.1234 W
        /(\d{1,3}\.\d{3,})\s*°?\s*([NS])[\s,]+(\d{1,3}\.\d{3,})\s*°?\s*([EW])/g,
    ];

    for (const p of decimalPatterns) {
        const matches = [...pageText.matchAll(p)];
        for (const m of matches) {
            let lat: number;
            let lng: number;
            if (m[2] === "N" || m[2] === "S") {
                lat = Number(m[1]) * (m[2] === "S" ? -1 : 1);
                lng = Number(m[3]) * (m[4] === "W" ? -1 : 1);
            } else {
                lat = Number(m[1]);
                lng = Number(m[2]);
            }
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
            // Colorado-ish sanity check optional; keep broad but reject clearly wrong sign for US
            if (lat > 18 && lat < 72 && lng > 0) continue;
            return { lat, lng };
        }
    }
    return null;
};

const extractPeakName = ($: cheerio.Root): string => {
    // Best: target the specific span with class="name" and itemprop="name" inside h1#peakName
    const nameSpan = $('h1#peakName span.name[itemprop="name"]').first().text().trim();
    if (nameSpan) return nameSpan;

    // Fallback: any itemprop="name" within the Mountain schema
    const schemaName = $('[itemtype*="schema.org/Mountain"] [itemprop="name"]').first().text().trim();
    if (schemaName) return schemaName;

    // Fallback: page title (cleaned)
    const title = $("title").text().trim();
    if (title) {
        // Remove " | Climb13ers" or similar suffix
        const cleaned = title.replace(/\s*\|.*$/, "").trim();
        if (cleaned) return cleaned;
    }

    // Last resort: h1 text cleaned of whitespace chaos
    const h1Text = $("h1").first().text().replace(/\s+/g, " ").trim();
    if (h1Text) {
        // Try to extract just the peak name portion (after elevation, before nickname)
        const match = h1Text.match(/\d{1,2},\d{3}['′]?\s*(.+?)(?:\s*[""]|$)/);
        if (match && match[1]) return match[1].trim();
        return h1Text;
    }

    return "Unknown Peak";
};

const extractElevationMeters = ($: cheerio.Root): number => {
    // Heuristic: if we can find something like "13,746'" or "13,746 ft"
    const text = $("body").text();
    const ftMatch = text.match(/(\d{1,2},\d{3})\s*(?:'|ft)\b/);
    if (ftMatch) {
        const ft = Number(ftMatch[1].replace(/,/g, ""));
        if (Number.isFinite(ft) && ft > 1000) return ft * 0.3048;
    }
    return 0;
};

const extractPeakCoords = ($: cheerio.Root): { lat: number; lng: number } | null => {
    // Prefer explicit map links
    const mapLinks = $("a")
        .map((_, a) => $(a).attr("href") || "")
        .get()
        .filter(Boolean);

    for (const href of mapLinks) {
        const coords = parseCoordsFromUrl(href);
        if (coords) return coords;
    }

    // Fallback: scan page text
    const coordsText = parseCoordsFromText($("body").text());
    if (coordsText) return coordsText;

    return null;
};

export const scrapeClimb13ersFromListPage = async (
    listUrl: string,
    options: ScrapeOptions = {}
): Promise<ExternalPeak[]> => {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const sleepMs = options.sleepMs ?? 500;

    console.log(`\nFetching Climb13ers list page: ${listUrl}`);
    const listResp = await fetch(listUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
    });
    if (!listResp.ok) {
        throw new Error(`Failed to fetch list page: ${listResp.status} ${listResp.statusText}`);
    }
    const listHtml = await listResp.text();
    if (isLikelyBlockedHtml(listHtml)) {
        throw new Error("Climb13ers appears to be protected/blocked (Cloudflare challenge detected) on the list page.");
    }

    const $list = cheerio.load(listHtml);

    // Known non-peak pages to exclude
    const excludedPaths = new Set([
        "/colorado-13ers/",
        "/colorado-13ers/peaks",
        "/colorado-13ers/ranges",
        "/colorado-13ers/difficulties",
        "/colorado-13ers/terminology",
        "/colorado-13ers/links",
        "/colorado-13ers/donate",
        "/colorado-13ers/donate/",
        "/colorado-13ers/trailheads-by-range",
        "/colorado-13ers/trailheads-by-access",
    ]);
    const excludedPatterns = [
        /\/trailhead/i,
        /\/trailhead-list/i,
        /\/top-\d+/i,           // top-100, top-200, etc.
        /\/class-\d/i,          // class-1, class-2, etc.
        /\-range$/i,            // front-range, san-juan-range, etc.
    ];

    // Heuristic: links that look like peak detail pages
    const links = new Set<string>();
    $list("a").each((_, a) => {
        const href = ($list(a).attr("href") || "").trim();
        if (!href) return;
        const abs = absolutize(baseUrl, href);
        if (!abs.startsWith(baseUrl)) return;
        try {
            const u = new URL(abs);
            const p = u.pathname.toLowerCase();
            
            // Must be under /colorado-13ers/
            if (!p.startsWith("/colorado-13ers/")) return;
            
            // Skip known non-peak paths
            if (excludedPaths.has(p)) return;
            
            // Skip patterns that match non-peak pages
            if (excludedPatterns.some((re) => re.test(p))) return;
            
            // Must have something after /colorado-13ers/ (i.e., a peak slug)
            const slug = p.replace("/colorado-13ers/", "").replace(/\/$/, "");
            if (!slug || slug.includes("/")) return; // No nested paths
            
            links.add(abs);
        } catch {
            // ignore
        }
    });

    const peakLinks = [...links];
    console.log(`Found ${peakLinks.length} candidate peak links on list page`);

    const maxPeaks = options.maxPeaks && options.maxPeaks > 0 ? options.maxPeaks : peakLinks.length;
    const selected = peakLinks
        .filter((u) => u !== listUrl)
        .slice(0, maxPeaks);

    const peaks: ExternalPeak[] = [];
    for (let i = 0; i < selected.length; i++) {
        const url = selected[i];
        console.log(`Fetching peak page ${i + 1}/${selected.length}: ${url}`);

        const resp = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept-Language": "en-US,en;q=0.9",
                Referer: listUrl,
            },
        });
        if (!resp.ok) {
            console.warn(`Failed to fetch peak page: ${resp.status} ${resp.statusText}`);
            await sleep(sleepMs);
            continue;
        }
        const html = await resp.text();
        if (isLikelyBlockedHtml(html)) {
            throw new Error("Climb13ers appears to be protected/blocked (Cloudflare challenge detected) on a peak page.");
        }
        const $ = cheerio.load(html);

        const name = extractPeakName($);
        const coords = extractPeakCoords($);
        if (!coords) {
            console.warn(`No coordinates found for: ${name}`);
            await sleep(sleepMs);
            continue;
        }

        const elevation = extractElevationMeters($);

        peaks.push({
            name,
            lat: coords.lat,
            lng: coords.lng,
            elevation,
            externalSource: "climb13ers",
            externalId: url,
            sourceUrl: url,
        });

        await sleep(sleepMs);
    }

    console.log(`Scraped ${peaks.length} peaks with coordinates from Climb13ers`);
    return peaks;
};

export default scrapeClimb13ersFromListPage;


