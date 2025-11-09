import Peak from "../typeDefs/Peak";

const getSummits = (
    prev: {
        [key: string]: {
            reset: boolean;
            lastIndex: number;
            summits: {
                index: number;
                points: {
                    lat: number;
                    lng: number;
                    distanceToPeak: number;
                    index: number;
                }[];
            }[];
        };
    },
    curr: {
        id: string;
        index: number;
        distanceToPeak: number;
        lat: number;
        lng: number;
    }[],
    currIndex: number
) => {
    curr.forEach((summit) => {
        if (prev[summit.id]) {
            if (
                prev[summit.id].reset &&
                currIndex > prev[summit.id].lastIndex + 300
            ) {
                prev[summit.id] = {
                    summits: [
                        ...prev[summit.id].summits,
                        {
                            index: prev[summit.id].summits.length,
                            points: [summit],
                        },
                    ],
                    reset: false,
                    lastIndex: currIndex,
                };
            } else {
                prev[summit.id].lastIndex = currIndex;
                prev[summit.id].summits[
                    prev[summit.id].summits.length - 1
                ].points.push(summit);
            }
        } else if (!prev[summit.id]) {
            prev[summit.id] = {
                summits: [
                    {
                        index: 0,
                        points: [summit],
                    },
                ],
                reset: false,
                lastIndex: currIndex,
            };
        }
    });
    Object.keys(prev).forEach((key) => {
        if (!curr.find((x) => x.id === key)) {
            prev[key].reset = true;
        }
    });
    return prev;
};

export default getSummits;
