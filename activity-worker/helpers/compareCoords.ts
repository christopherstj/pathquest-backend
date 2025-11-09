import Peak from "../typeDefs/Peak";

const compareCoords = (
    peak: Peak,
    lat: number,
    long: number,
    delta: { lat: number; long: number }
) => {
    if (
        peak.lat >= lat - delta.lat &&
        peak.lat <= lat + delta.lat &&
        peak.lng >= long - delta.long &&
        peak.lng <= long + delta.long
    ) {
        return true;
    }
    return false;
};

export default compareCoords;
