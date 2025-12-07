import { performance } from "perf_hooks";
import detectSummits from "../helpers/detectSummits";
import Peak from "../typeDefs/Peak";
import { Point } from "../helpers/detectSummits";

const generateData = (pointsCount: number, peaksCount: number) => {
    const points: Point[] = [];
    const peaks: Peak[] = [];

    for (let i = 0; i < pointsCount; i++) {
        // synthetic walk near a center
        const lat = 40 + Math.sin(i / 1000) * 0.01 + (Math.random() - 0.5) * 0.0005;
        const lng = -105 + Math.cos(i / 1000) * 0.01 + (Math.random() - 0.5) * 0.0005;
        points.push({ lat, lng, time: i, index: i });
    }

    for (let i = 0; i < peaksCount; i++) {
        peaks.push({
            id: `peak-${i}`,
            name: `Peak ${i}`,
            lat: 40 + Math.sin(i) * 0.02,
            lng: -105 + Math.cos(i) * 0.02,
            elevation: 4000 + i,
        });
    }

    return { points, peaks };
};

const run = () => {
    const { points, peaks } = generateData(2000, 50);
    const iterations = 5;
    const durations: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        detectSummits(points, peaks);
        durations.push(performance.now() - start);
    }
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    console.log(
        `Benchmark (points=2000, peaks=50, runs=${iterations}): avg ${avg.toFixed(
            2
        )} ms`
    );
};

run();


