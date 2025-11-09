const getBoundingBox = (
    acc: {
        minLat: number;
        maxLat: number;
        minLong: number;
        maxLong: number;
    },
    [lng, lat]: [number, number],
    delta: { lat: number; long: number }
) => {
    return {
        minLat: Math.min(acc.minLat, lat - delta.lat),
        maxLat: Math.max(acc.maxLat, lat + delta.lat),
        minLong: Math.min(acc.minLong, lng - delta.long),
        maxLong: Math.max(acc.maxLong, lng + delta.long),
    };
};

export default getBoundingBox;
