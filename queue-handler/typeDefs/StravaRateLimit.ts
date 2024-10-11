export default interface StravaRateLimit {
    shortTermLimit: number;
    dailyLimit: number;
    shortTermUsage: number;
    dailyUsage: number;
}
