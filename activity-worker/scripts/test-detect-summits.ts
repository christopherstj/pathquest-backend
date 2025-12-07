import detectSummits from "../helpers/detectSummits";
import { Point } from "../helpers/detectSummits";
import Peak from "../typeDefs/Peak";

const assert = (condition: boolean, message: string) => {
    if (!condition) {
        throw new Error(message);
    }
};

const buildPoints = (coords: [number, number][], times: number[]): Point[] =>
    coords.map(([lng, lat], index) => ({
        lat,
        lng,
        time: times[index],
        index,
    }));

const peaks: Peak[] = [
    { id: "p1", name: "Peak One", lat: 40.0, lng: -105.0, elevation: 4300 },
    {
        id: "p2",
        name: "Peak Two",
        lat: 40.001,
        lng: -105.002,
        elevation: 4280,
    },
];

const testSingleSummit = () => {
    const coords: [number, number][] = [
        [-105.01, 40.0],
        [-105.005, 40.0005],
        [-105.0005, 40.0], // close to p1
        [-105.0004, 40.0],
        [-105.002, 40.0006],
    ];
    const times = [0, 30, 60, 90, 120];
    const points = buildPoints(coords, times);
    const res = detectSummits(points, peaks);
    assert(res.length === 1, "Expected one summit");
    assert(res[0].id === "p1", "Expected summit on p1");
};

const testMultiPassSamePeak = () => {
    const coords: [number, number][] = [
        [-105.0005, 40.0],
        [-105.0004, 40.0002],
        [-105.01, 40.0], // move away
        [-105.02, 39.99],
        [-105.0006, 40.0], // return near p1
        [-105.0005, 40.0001],
    ];
    const times = [0, 30, 200, 400, 600, 630]; // gap > reset threshold between visits
    const points = buildPoints(coords, times);
    const res = detectSummits(points, peaks);
    assert(res.length === 2, "Expected two summits for two passes");
    assert(res.every((r) => r.id === "p1"), "Both summits should be p1");
};

const testIgnoreBriefSpike = () => {
    const coords: [number, number][] = [
        [-105.01, 40.0],
        [-105.0005, 40.0], // single near point
        [-105.01, 40.0],
        [-105.02, 40.0],
    ];
    const times = [0, 10, 20, 30];
    const points = buildPoints(coords, times);
    const res = detectSummits(points, peaks);
    assert(res.length === 0, "Expected no summit for brief spike");
};

const run = () => {
    testSingleSummit();
    testMultiPassSamePeak();
    testIgnoreBriefSpike();
    console.log("detectSummits tests passed.");
};

run();


