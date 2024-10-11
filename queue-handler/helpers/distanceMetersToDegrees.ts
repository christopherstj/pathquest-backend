const distanceMetersToDegrees = (
    distance: number,
    initialLat: number
): {
    lat: number;
    long: number;
} => {
    const latDelta = distance / 110574;
    const longDelta = distance / (111320 * Math.cos(initialLat));

    return {
        lat: Math.abs(latDelta),
        long: Math.abs(longDelta),
    };
};

export default distanceMetersToDegrees;
