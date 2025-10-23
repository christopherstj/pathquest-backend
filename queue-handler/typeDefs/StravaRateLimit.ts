export default interface StravaRateLimit {
    short_term_limit: number;
    daily_limit: number;
    short_term_usage: number;
    daily_usage: number;
}
