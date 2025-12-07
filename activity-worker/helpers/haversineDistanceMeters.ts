const toRad = (deg: number) => (deg * Math.PI) / 180;

// Returns distance in meters between two lat/lng points
const haversineDistanceMeters = (
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
) => {
    const R = 6371000; // meters
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

export default haversineDistanceMeters;


