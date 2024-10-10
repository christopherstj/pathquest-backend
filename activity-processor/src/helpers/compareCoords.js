"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const compareCoords = (peak, lat, long, delta) => {
    if (peak.Lat >= lat - delta.lat &&
        peak.Lat <= lat + delta.lat &&
        peak.Long >= long - delta.long &&
        peak.Long <= long + delta.long) {
        return true;
    }
    return false;
};
exports.default = compareCoords;
