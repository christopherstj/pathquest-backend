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

    const response = await fetch(url);
    const data = await response.json();

    // Get the closest hour's data
    return {
        temperature: data.hourly.temperature_2m[hour],
        precipitation: data.hourly.precipitation[hour],
        weatherCode: data.hourly.weathercode[hour],
        cloudCover: data.hourly.cloudcover[hour],
        windSpeed: data.hourly.windspeed_10m[hour],
        windDirection: data.hourly.winddirection_10m[hour],
        humidity: data.hourly.relativehumidity_2m[hour],
    };
};

export default getHistoricalWeatherByCoords;
