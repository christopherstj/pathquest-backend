const getBoundingBox = (
    acc: {
        minLat: number;
        maxLat: number;
        minLong: number;
        maxLong: number;
    },
    [lat, long]: [number, number],
    delta: { lat: number; long: number }
) => {
    return {
        minLat: Math.min(acc.minLat, lat - delta.lat),
        maxLat: Math.max(acc.maxLat, lat + delta.lat),
        minLong: Math.min(acc.minLong, long - delta.long),
        maxLong: Math.max(acc.maxLong, long + delta.long),
    };
};

export default getBoundingBox;
