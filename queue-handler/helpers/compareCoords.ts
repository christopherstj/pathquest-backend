import Peak from "../typeDefs/Peak";

const compareCoords = (
    peak: Peak,
    lat: number,
    long: number,
    delta: { lat: number; long: number }
) => {
    if (
        peak.Lat >= lat - delta.lat &&
        peak.Lat <= lat + delta.lat &&
        peak.Long >= long - delta.long &&
        peak.Long <= long + delta.long
    ) {
        return true;
    }
    return false;
};

export default compareCoords;
