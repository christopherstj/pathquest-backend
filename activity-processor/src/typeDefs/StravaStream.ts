export interface StravaLatLngStream {
    type: "latlng";
    data: [number, number][];
    series_type: string;
    original_size: number;
    resolution: string;
}
export interface StravaTimeStream {
    type: "time";
    data: number[];
    series_type: string;
    original_size: number;
    resolution: string;
}
