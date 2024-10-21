import mysql, { RowDataPacket } from "mysql2/promise";
import Peak from "../typeDefs/Peak";
import { AddressType, Client } from "@googlemaps/google-maps-services-js";

const client = new Client({});

const geocodePeaks = async () => {
    const connection = await mysql.createConnection({
        host: "127.0.0.1",
        user: "local-user",
        database: "dev-db",
        password: process.env.MYSQL_PASSWORD ?? "",
    });

    const [rows] = await connection.query<(Peak & RowDataPacket)[]>(
        "SELECT * FROM Peak WHERE Country IS NULL AND State IS NULL AND County IS NULL ORDER BY Altitude DESC LIMIT 8000"
    );

    for (const peak of rows) {
        if (peak.Country || peak.State || peak.County) {
            continue;
        }
        const geocodeRes = await client.reverseGeocode({
            params: {
                latlng: `${peak.Lat},${peak.Long}`,
                result_type: [
                    AddressType.country,
                    AddressType.administrative_area_level_1,
                    AddressType.administrative_area_level_2,
                ],
                key: process.env.GOOGLE_MAPS_API_KEY ?? "",
            },
        });

        if (
            geocodeRes.data.status !== "OK" ||
            !geocodeRes.data.results[0]?.address_components
        ) {
            console.error(
                `Failed to geocode peak ${peak.Id}: ${geocodeRes.data.status}`
            );
            return peak;
        }

        const addressComponents = geocodeRes.data.results[0].address_components;

        const country = addressComponents.find((x) =>
            x.types.includes(AddressType.country)
        )?.short_name;
        const state = addressComponents.find((x) =>
            x.types.includes(AddressType.administrative_area_level_1)
        )?.short_name;
        const county = addressComponents.find((x) =>
            x.types.includes(AddressType.administrative_area_level_2)
        )?.short_name;

        const newPeak = {
            ...peak,
            Country: country,
            State: state,
            County: county,
        };

        connection.query(
            "UPDATE Peak SET Country = ?, State = ?, County = ? WHERE Id = ?",
            [newPeak.Country, newPeak.State, newPeak.County, newPeak.Id]
        );

        console.log(`Geocoded peak ${peak.Name}`);
    }

    console.log("Geocoded peaks");
};

export default geocodePeaks;
