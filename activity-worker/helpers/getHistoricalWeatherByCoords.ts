const getHistoricalWeatherByCoords = async (
    timestamp: Date,
    coords: { lat: number; lon: number },
    elevation: number
) => {
    const dateStr = timestamp.toISOString().split("T")[0];
    const hour = timestamp.getUTCHours();

    const url =
        `https://archive-api.open-meteo.com/v1/archive?` +
        `latitude=${coords.lat}&longitude=${coords.lon}&` +
        `start_date=${dateStr}&end_date=${dateStr}&` +
        `hourly=temperature_2m,precipitation,weathercode,cloudcover,windspeed_10m,winddirection_10m,relativehumidity_2m&` +
        `elevation=${elevation}&` +
        `timezone=UTC`;

    try {
        const response = await fetch(url);
        
        if (!response.ok) {
            console.warn(
                `Weather API error for ${coords.lat},${coords.lon} on ${dateStr}: ${response.status} ${response.statusText}`
            );
            // Return null values on API error
            return {
                temperature: null,
                precipitation: null,
                weatherCode: null,
                cloudCover: null,
                windSpeed: null,
                windDirection: null,
                humidity: null,
            };
        }

        const data = await response.json();

        // Check if data structure is valid
        if (!data.hourly || !data.hourly.temperature_2m) {
            console.warn(
                `Invalid weather data structure for ${coords.lat},${coords.lon} on ${dateStr}`
            );
            return {
                temperature: null,
                precipitation: null,
                weatherCode: null,
                cloudCover: null,
                windSpeed: null,
                windDirection: null,
                humidity: null,
            };
        }

        // Get the closest hour's data (use last available hour if requested hour doesn't exist)
        const dataHour = Math.min(hour, data.hourly.temperature_2m.length - 1);

        return {
            temperature: data.hourly.temperature_2m[dataHour] ?? null,
            precipitation: data.hourly.precipitation[dataHour] ?? null,
            weatherCode: data.hourly.weathercode[dataHour] ?? null,
            cloudCover: data.hourly.cloudcover[dataHour] ?? null,
            windSpeed: data.hourly.windspeed_10m[dataHour] ?? null,
            windDirection: data.hourly.winddirection_10m[dataHour] ?? null,
            humidity: data.hourly.relativehumidity_2m[dataHour] ?? null,
        };
    } catch (error) {
        console.error(
            `Error fetching weather for ${coords.lat},${coords.lon} on ${dateStr}:`,
            error instanceof Error ? error.message : String(error)
        );
        // Return null values on error
        return {
            temperature: null,
            precipitation: null,
            weatherCode: null,
            cloudCover: null,
            windSpeed: null,
            windDirection: null,
            humidity: null,
        };
    }
};

export default getHistoricalWeatherByCoords;
