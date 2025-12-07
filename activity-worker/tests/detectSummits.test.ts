import { describe, it, expect } from "vitest";
import detectSummits from "../helpers/detectSummits";
import type Peak from "../typeDefs/Peak";
import type { Point } from "../helpers/detectSummits";

const peak: Peak = {
    id: "peak-1",
    name: "Test Peak",
    lat: 40,
    lng: -105,
    elevation: 3000,
    country: "US",
    state: "CO",
};

const createPoint = (
    lat: number,
    lng: number,
    time: number,
    index: number
): Point => ({ lat, lng, time, index });

describe("detectSummits", () => {
    it("returns empty when no points or peaks", () => {
        expect(detectSummits([], [])).toEqual([]);
        expect(detectSummits([], [peak])).toEqual([]);
    });

    it("detects a single summit when passing near a peak", () => {
        const points: Point[] = [
            createPoint(39.999, -105, 0, 0), // far
            createPoint(40.0005, -105, 60, 1), // within 80m
            createPoint(40.0006, -105, 120, 2), // still within
            createPoint(40.002, -105, 400, 3), // exited
        ];

        const result = detectSummits(points, [peak]);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(peak.id);
        expect(result[0].index).toBe(1);
    });

    it("allows a second summit after exiting beyond reset gap", () => {
        const points: Point[] = [
            createPoint(39.999, -105, 0, 0),
            createPoint(40.0005, -105, 60, 1),
            createPoint(40.0006, -105, 120, 2),
            createPoint(40.002, -105, 400, 3), // exit beyond EXIT_DISTANCE_METERS
            createPoint(40.003, -105, 700, 4), // stay out long enough (>= RESET_GAP_SECONDS)
            createPoint(40.0005, -105, 900, 5), // re-enter
            createPoint(40.0006, -105, 960, 6),
            createPoint(40.00055, -105, 1020, 7),
            createPoint(40.002, -105, 1300, 8), // exit again
        ];

        const result = detectSummits(points, [peak]);

        expect(result).toHaveLength(2);
        expect(result.map((r) => r.index)).toEqual([1, 5]);
    });
});

