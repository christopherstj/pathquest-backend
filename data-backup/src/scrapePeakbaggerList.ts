import * as cheerio from "cheerio";
import { ExternalPeak, PeakbaggerListConfig } from "../typeDefs/ChallengeImport";

const FEET_TO_METERS = 0.3048;

interface PeakbaggerPeakRaw {
    name: string;
    peakId: string;
    elevation: number; // feet
    prominence?: number; // feet
    rank?: number; // ranking number (if ranked peak)
}

interface ScrapeOptions {
    rankedOnly?: boolean; // Only include peaks with a ranking number
}

/**
 * Scrapes a Peakbagger list page to get peak names and IDs.
 * Then fetches individual peak pages to get coordinates.
 */
export const scrapePeakbaggerList = async (
    config: PeakbaggerListConfig,
    options: ScrapeOptions = {}
): Promise<ExternalPeak[]> => {
    console.log(`\nFetching Peakbagger list: ${config.name} (ID: ${config.listId})`);
    if (options.rankedOnly) {
        console.log(`Filtering: RANKED PEAKS ONLY`);
    }

    const listUrl = `https://peakbagger.com/list.aspx?lid=${config.listId}`;
    const response = await fetch(listUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch list: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Parse the list table to get peak names, IDs, and basic info
    const rawPeaks: PeakbaggerPeakRaw[] = [];

    // Peakbagger tables typically have alternating row colors
    // Look for links to peak pages in the table
    $("table tr").each((i, row) => {
        const cells = $(row).find("td");
        if (cells.length < 2) return;

        // Check for ranking number FIRST (before any other parsing)
        const firstCellText = $(cells[0]).text().trim();
        const rankMatch = firstCellText.match(/^(\d+)\.?\s*$/);
        let finalRank: number | undefined = rankMatch ? parseInt(rankMatch[1], 10) : undefined;

        // Also check second column if first doesn't have rank
        if (!finalRank && cells.length > 1) {
            const secondCellText = $(cells[1]).text().trim();
            const altRankMatch = secondCellText.match(/^(\d+)\.?\s*$/);
            finalRank = altRankMatch ? parseInt(altRankMatch[1], 10) : undefined;
        }

        // If rankedOnly filter is on, skip peaks without a rank (early exit)
        if (options.rankedOnly && !finalRank) {
            return;
        }

        // Find the peak link (usually in first or second column)
        const peakLink = $(row).find('a[href*="peak.aspx?pid="]').first();
        if (!peakLink.length) return;

        const href = peakLink.attr("href") || "";
        const pidMatch = href.match(/pid=(\d+)/);
        if (!pidMatch) return;

        const peakId = pidMatch[1];
        const name = peakLink.text().trim();

        // Try to find elevation and prominence from cells
        let elevation = 0;
        let prominence: number | undefined;

        cells.each((j, cell) => {
            const text = $(cell).text().trim().replace(/,/g, "");
            const num = parseFloat(text);

            // Heuristic: elevation is typically 4-5 digit number, prominence is smaller
            if (!isNaN(num) && num > 1000 && num < 25000 && elevation === 0) {
                // First large number is likely elevation
                if (j > 0) {
                    // Skip first column which might be rank
                    elevation = num;
                }
            } else if (!isNaN(num) && num > 0 && num < 5000 && elevation > 0 && !prominence) {
                // After elevation, smaller number might be prominence
                prominence = num;
            }
        });

        if (name && peakId) {
            rawPeaks.push({ name, peakId, elevation, prominence, rank: finalRank });
        }
    });

    console.log(`Found ${rawPeaks.length} peaks in list`);
    if (options.rankedOnly) {
        console.log(`(filtered to ranked peaks only)`);
    }

    // Now fetch coordinates for each peak
    const peaks: ExternalPeak[] = [];
    const batchSize = 5; // Fetch 5 at a time to be respectful

    for (let i = 0; i < rawPeaks.length; i += batchSize) {
        const batch = rawPeaks.slice(i, i + batchSize);
        const batchPromises = batch.map((p) => fetchPeakCoordinates(p));
        const batchResults = await Promise.all(batchPromises);

        for (const result of batchResults) {
            if (result) {
                peaks.push(result);
            }
        }

        // Progress update
        console.log(`Fetched coordinates: ${Math.min(i + batchSize, rawPeaks.length)}/${rawPeaks.length}`);

        // Small delay between batches
        if (i + batchSize < rawPeaks.length) {
            await sleep(500);
        }
    }

    return peaks;
};

/**
 * Fetches a single peak page to get coordinates
 */
const fetchPeakCoordinates = async (
    raw: PeakbaggerPeakRaw
): Promise<ExternalPeak | null> => {
    try {
        const peakUrl = `https://peakbagger.com/peak.aspx?pid=${raw.peakId}`;
        const response = await fetch(peakUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
        });

        if (!response.ok) {
            console.warn(`Failed to fetch peak ${raw.name}: ${response.status}`);
            return null;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        let lat: number | null = null;
        let lng: number | null = null;

        // Method 1: Look for Google Maps link (most reliable)
        const gmapsLink = $('a[href*="maps.google.com"]').attr("href") || 
                          $('a[href*="google.com/maps"]').attr("href");
        if (gmapsLink) {
            const coordMatch = gmapsLink.match(/[?&]q=([-\d.]+),([-\d.]+)/);
            if (coordMatch) {
                lat = parseFloat(coordMatch[1]);
                lng = parseFloat(coordMatch[2]);
            }
        }

        // Method 2: Look for OpenStreetMap link
        if (!isValidCoords(lat, lng)) {
            const osmLink = $('a[href*="openstreetmap.org"]').attr("href");
            if (osmLink) {
                const latMatch = osmLink.match(/mlat=([-\d.]+)/);
                const lngMatch = osmLink.match(/mlon=([-\d.]+)/);
                if (latMatch && lngMatch) {
                    lat = parseFloat(latMatch[1]);
                    lng = parseFloat(lngMatch[1]);
                }
            }
        }

        // Method 3: Generic coordinate pattern - two decimal numbers with max 3 digits before decimal
        // Pattern matches: "36.5786, -118.2920" or "36.5786 N 118.2920 W" etc.
        // Key insight: coordinates always have decimals, max 3 digits before decimal
        if (!isValidCoords(lat, lng)) {
            const pageText = $("body").text();
            
            // Look for coordinate-like pairs: 1-3 digits, decimal point, more digits
            // Followed by optional N/S, then another similar number with optional E/W
            const coordPatterns = [
                // Pattern: 36.5786°N, 118.2920°W or 36.5786 N, 118.2920 W
                /(\d{1,3}\.\d{3,})\s*°?\s*([NS])[\s,]+(\d{1,3}\.\d{3,})\s*°?\s*([EW])/g,
                // Pattern: 36.5786, -118.2920 (signed decimals)
                /([-]?\d{1,3}\.\d{3,})[\s,]+([-]?\d{1,3}\.\d{3,})/g,
            ];

            for (const pattern of coordPatterns) {
                const matches = [...pageText.matchAll(pattern)];
                for (const match of matches) {
                    let testLat: number;
                    let testLng: number;

                    if (match[2] === "N" || match[2] === "S") {
                        // Pattern with N/S E/W
                        testLat = parseFloat(match[1]);
                        if (match[2] === "S") testLat = -testLat;
                        testLng = parseFloat(match[3]);
                        if (match[4] === "W") testLng = -testLng;
                    } else {
                        // Signed decimal pattern
                        testLat = parseFloat(match[1]);
                        testLng = parseFloat(match[2]);
                    }

                    if (isValidCoords(testLat, testLng)) {
                        lat = testLat;
                        lng = testLng;
                        break;
                    }
                }
                if (isValidCoords(lat, lng)) break;
            }
        }

        // Method 4: DMS format - 36°34'43"N, 118°17'31"W
        if (!isValidCoords(lat, lng)) {
            const pageText = $("body").text();
            const dmsMatch = pageText.match(
                /(\d{1,3})[°]\s*(\d{1,2})?[′']\s*(\d{1,2}(?:\.\d+)?)?[″"]?\s*([NS])[\s,]+(\d{1,3})[°]\s*(\d{1,2})?[′']\s*(\d{1,2}(?:\.\d+)?)?[″"]?\s*([EW])/
            );
            if (dmsMatch) {
                lat = dmsToDecimal(
                    parseFloat(dmsMatch[1]),
                    parseFloat(dmsMatch[2] || "0"),
                    parseFloat(dmsMatch[3] || "0"),
                    dmsMatch[4]
                );
                lng = dmsToDecimal(
                    parseFloat(dmsMatch[5]),
                    parseFloat(dmsMatch[6] || "0"),
                    parseFloat(dmsMatch[7] || "0"),
                    dmsMatch[8]
                );
            }
        }

        if (!isValidCoords(lat, lng)) {
            console.warn(`Could not find valid coordinates for ${raw.name} (pid=${raw.peakId})`);
            return null;
        }

        // Extract county from Peakbagger page
        // Look for table row with "County/Second Level Region" label
        let county: string | undefined;
        $("table tr").each((i, row) => {
            const cells = $(row).find("td");
            if (cells.length >= 2) {
                const label = $(cells[0]).text().trim();
                if (label.includes("County") || label.includes("Second Level Region")) {
                    county = $(cells[1]).text().trim();
                    // Clean up county name (remove extra whitespace, etc.)
                    county = county.replace(/\s+/g, " ").trim();
                    return false; // Break out of loop
                }
            }
        });

        return {
            name: raw.name,
            lat: lat!,
            lng: lng!,
            elevation: raw.elevation * FEET_TO_METERS,
            prominence: raw.prominence ? raw.prominence * FEET_TO_METERS : undefined,
            rank: raw.rank,
            peakId: raw.peakId,
            county: county || undefined,
        };
    } catch (error) {
        console.warn(`Error fetching peak ${raw.name}:`, error);
        return null;
    }
};

/**
 * Validate that coordinates are within reasonable bounds for US peaks
 */
const isValidCoords = (lat: number | null, lng: number | null): boolean => {
    if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
        return false;
    }
    // Basic bounds check
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return false;
    }
    // For US peaks: lat roughly 18-72, lng roughly -180 to -65
    // Most continental US: lat 24-50, lng -125 to -65
    // Reject if lat looks like US but lng is positive (wrong sign)
    if (lat > 18 && lat < 72 && lng > 0) {
        return false;
    }
    // Reject clearly invalid coordinate-looking values (too small for real coords)
    if (Math.abs(lat) < 1 || Math.abs(lng) < 1) {
        return false;
    }
    return true;
};

/**
 * Convert DMS (degrees, minutes, seconds) to decimal degrees
 */
const dmsToDecimal = (
    degrees: number,
    minutes: number,
    seconds: number,
    direction: string
): number => {
    let decimal = degrees + minutes / 60 + seconds / 3600;
    if (direction === "S" || direction === "W") {
        decimal = -decimal;
    }
    return decimal;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Alternative: Load peaks from a JSON file
 * Use this if you've manually compiled a list or have a pre-existing dataset
 */
export const loadPeaksFromJson = async (filePath: string): Promise<ExternalPeak[]> => {
    const fs = await import("fs");
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as ExternalPeak[];
};

/**
 * Save peaks to a JSON file for caching/editing
 */
export const savePeaksToJson = async (
    peaks: ExternalPeak[],
    filePath: string
): Promise<void> => {
    const fs = await import("fs");
    fs.writeFileSync(filePath, JSON.stringify(peaks, null, 2));
    console.log(`Saved ${peaks.length} peaks to ${filePath}`);
};

export default scrapePeakbaggerList;

