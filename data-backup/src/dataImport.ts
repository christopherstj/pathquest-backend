// import fs from "fs";
// import mysql from "mysql2/promise";
// import PeakJson from "./typeDefs/PeakJson";
// import Peak from "./typeDefs/Peak";

// const stateCodes = [
//     "AL",
//     "AK",
//     "AZ",
//     "AR",
//     "CA",
//     "CO",
//     "CT",
//     "DE",
//     "FL",
//     "GA",
//     "HI",
//     "ID",
//     "IL",
//     "IN",
//     "IA",
//     "KS",
//     "KY",
//     "LA",
//     "ME",
//     "MD",
//     "MA",
//     "MI",
//     "MN",
//     "MS",
//     "MO",
//     "MT",
//     "NE",
//     "NV",
//     "NH",
//     "NJ",
//     "NM",
//     "NY",
//     "NC",
//     "ND",
//     "OH",
//     "OK",
//     "OR",
//     "PA",
//     "RI",
//     "SC",
//     "SD",
//     "TN",
//     "TX",
//     "UT",
//     "VT",
//     "VA",
//     "WA",
//     "WV",
//     "WI",
//     "WY",
// ];

// const main = async () => {
//     // Create the connection to database
//     const connection = await mysql.createConnection({
//         host: "127.0.0.1",
//         user: "local-user",
//         database: "dev-db",
//         password: process.env.MYSQL_PASSWORD ?? "",
//     });

//     stateCodes.forEach(async (stateCode) => {
//         const rawData = fs.readFileSync(
//             `./stateData/${stateCode}.json`,
//             "utf8"
//         );
//         const data: PeakJson[] = JSON.parse(rawData);

//         const parsedData = data.map(
//             (x): Peak => ({
//                 Id: x.geonameId.toString(),
//                 Name: x.name,
//                 Lat: parseFloat(x.lat),
//                 Long: parseFloat(x.lng),
//             })
//         );

//         // Insert data into database
//         await connection.query(
//             "INSERT INTO Peak (Id, `Name`, Lat, `Long`, Altitude) VALUES ?",
//             [parsedData.map((x) => [x.Id, x.Name, x.Lat, x.Long, null])]
//         );

//         console.log(`Inserted ${stateCode}.json into database`);

//         // const res = await fetch(
//         //     `http://api.geonames.org/searchJSON?featureCode=MT&country=US&adminCode1=${stateCode}&maxRows=1&username=christopherstj`
//         // );
//         // const json = await res.json();

//         // const allRows = json.totalResultsCount;

//         // const rowsPerPage = 1000;

//         // const pages = Math.ceil(allRows / rowsPerPage);

//         // const promises = [];

//         // for (let i = 0; i < pages; i++) {
//         //     promises.push(
//         //         fetch(
//         //             `http://api.geonames.org/searchJSON?featureCode=MT&adminCode1=${stateCode}&country=US&maxRows=${rowsPerPage}&startRow=${
//         //                 i * rowsPerPage
//         //             }&username=christopherstj`
//         //         )
//         //     );
//         // }

//         // const responses = await Promise.all(promises);

//         // const data = (
//         //     await Promise.all(
//         //         responses.map(async (res) => (await res.json()).geonames)
//         //     )
//         // ).flatMap((x) => x);

//         // await fs.writeFile(
//         //     `./stateData/${stateCode}.json`,
//         //     JSON.stringify(data),
//         //     () => {
//         //         console.log(`Wrote ${stateCode}.json`);
//         //     }
//         // );
//     });
// };

// export default main;
