"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const distanceMetersToDegrees = (distance, initialLat) => {
    const latDelta = distance / 110574;
    const longDelta = distance / (111320 * Math.cos(initialLat));
    return {
        lat: Math.abs(latDelta),
        long: Math.abs(longDelta),
    };
};
exports.default = distanceMetersToDegrees;
