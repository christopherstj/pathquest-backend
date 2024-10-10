"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const getSummits = (prev, curr, currIndex) => {
    curr.forEach((peakId) => {
        if (prev[peakId]) {
            if (prev[peakId].reset &&
                currIndex > prev[peakId].lastIndex + 300) {
                prev[peakId] = {
                    count: prev[peakId].count + 1,
                    reset: false,
                    lastIndex: currIndex,
                };
            }
            else {
                prev[peakId].lastIndex = currIndex;
            }
        }
        else if (!prev[peakId]) {
            prev[peakId] = {
                count: 1,
                reset: false,
                lastIndex: currIndex,
            };
        }
    });
    Object.keys(prev).forEach((key) => {
        if (!curr.find((x) => x === key)) {
            prev[key].reset = true;
        }
    });
    return prev;
};
exports.default = getSummits;
