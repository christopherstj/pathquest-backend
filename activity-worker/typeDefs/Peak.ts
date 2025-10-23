export default interface Peak {
    id: string;
    name: string;
    lng: number;
    lat: number;
    elevation?: number;
    city?: string;
    state?: string;
    country?: string;
}
