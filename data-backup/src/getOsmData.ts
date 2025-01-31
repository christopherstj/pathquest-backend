import fs from "fs";

const getOsmData = async () => {
    // Alaska:
    // node["natural"="volcano"](51.214183, -180, 71.365162, -129);
    // node["natural"="peak"](51.214183, -180, 71.365162, -129);

    // Hawaii:
    // node["natural"="volcano"](18.91727560534605, -160.24970712717126, 22.23238695135951, -154.80833743387433);
    // node["natural"="peak"](18.91727560534605, -160.24970712717126, 22.23238695135951, -154.80833743387433);

    // Continental US:
    // node["natural"="volcano"](24.396308, -125.0, 49.384358, -66.93457);
    // node["natural"="peak"](24.396308, -125.0, 49.384358, -66.93457);
    // node["natural"="hill"](24.396308, -125.0, 49.384358, -66.93457);

    const query = `
        [out:json];
        (
            node["natural"="hill"](24.396308, -125.0, 49.384358, -66.93457);
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
