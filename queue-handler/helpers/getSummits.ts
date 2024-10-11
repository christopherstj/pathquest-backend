import Peak from "../typeDefs/Peak";

const getSummits = (
    prev: {
        [key: string]: {
            reset: boolean;
            lastIndex: number;
            summits: {
                index: number;
            }[];
        };
    },
    curr: {
        id: string;
        index: number;
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
                            index: currIndex,
                        },
                    ],
                    reset: false,
                    lastIndex: currIndex,
                };
            } else {
                prev[summit.id].lastIndex = currIndex;
            }
        } else if (!prev[summit.id]) {
            prev[summit.id] = {
                summits: [
                    {
                        index: currIndex,
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
