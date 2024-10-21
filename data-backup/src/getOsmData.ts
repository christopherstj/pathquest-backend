import fs from "fs";

const getOsmData = async () => {
    const query = `
        [out:json];
        (
            node["natural"="volcano"](24.396308, -125.0, 49.384358, -66.93457);
            node["natural"="peak"](24.396308, -125.0, 49.384358, -66.93457);
        );
        out;
    `;
    const queryString = `data=${encodeURIComponent(query)}`;

    const response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: queryString,
    });

    const data = await response.text();

    fs.writeFileSync("./src/summits.json", data);
};

export default getOsmData;
