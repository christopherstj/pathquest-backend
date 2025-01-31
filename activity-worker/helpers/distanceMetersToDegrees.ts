const distanceMetersToDegrees = (
    distanceMeters: number,
    initialLat: number
): {
    lat: number;
    long: number;
} => {
    const latDelta = distanceMeters / 110574;
    const circumferenceOfEarth = 40075000;
    const circumferenceAtLat =
        circumferenceOfEarth * Math.cos(initialLat / 57.2958); // 57.2958 is the conversion factor from degrees to radians
    const longDelta = (distanceMeters / circumferenceAtLat) * 360;

    return {
        lat: Math.abs(latDelta),
        long: Math.abs(longDelta),
    };
};

export default distanceMetersToDegrees;
