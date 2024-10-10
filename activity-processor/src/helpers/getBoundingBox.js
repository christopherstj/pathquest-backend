"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const getBoundingBox = (acc, [lat, long], delta) => {
    return {
        minLat: Math.min(acc.minLat, lat - delta.lat),
        maxLat: Math.max(acc.maxLat, lat + delta.lat),
        minLong: Math.min(acc.minLong, long - delta.long),
        maxLong: Math.max(acc.maxLong, long + delta.long),
    };
};
exports.default = getBoundingBox;
