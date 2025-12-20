import StravaRateLimit from "../typeDefs/StravaRateLimit";
import getCloudSqlConnection from "./getCloudSqlConnection";
import getStravaAccessToken from "./getStravaAccessToken";
import setUsageData from "./setUsageData";

// How often the queue handler runs (in times per hour)
const RUNS_PER_HOUR = 12; // Every 5 minutes

// Reserve this percentage of daily budget for webhook bursts
const WEBHOOK_RESERVE_PERCENT = 0.1;

/**
 * Calculate hours remaining until Strava rate limit resets (midnight UTC)
 */
const getHoursUntilReset = (): number => {
    const now = new Date();
    const hoursUntilMidnight =
        24 - now.getUTCHours() - now.getUTCMinutes() / 60;
    // Minimum 0.5 hours to avoid division issues near midnight
    return Math.max(hoursUntilMidnight, 0.5);
};

/**
 * Calculate sustainable rate limit allowance that distributes API usage
 * evenly throughout the day, rather than burning through quota quickly.
 *
 * This ensures webhooks can always be processed (real-time activities)
 * while historical imports happen at a sustainable pace.
 *
 * @param checkStrava - Whether to ping Strava API to refresh rate limit data
 * @returns Number of activities (not requests) that can be processed this run
 */
const checkRateLimit = async (checkStrava: boolean) => {
    const pool = await getCloudSqlConnection();

    if (checkStrava) {
        const accessToken = await getStravaAccessToken("22686051");

        const accountRes = await fetch(
            `https://www.strava.com/api/v3/athlete`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        await setUsageData(accountRes.headers);
    }

    const { rows } = await pool.query<StravaRateLimit>(`
        SELECT * FROM strava_rate_limits
    `);

    if (rows.length === 0) {
        return 0;
    }

    const rateLimit = rows[0];

    // Calculate remaining capacity
    const dailyRemaining = rateLimit.daily_limit - rateLimit.daily_usage;
    const shortTermRemaining =
        rateLimit.short_term_limit - rateLimit.short_term_usage;

    // If we're out of capacity, return 0
    if (dailyRemaining <= 0 || shortTermRemaining <= 0) {
        console.log("Rate limit exhausted", {
            dailyRemaining,
            shortTermRemaining,
        });
        return 0;
    }

    // Calculate sustainable rate for historical activities
    // Reserve some capacity for webhooks
    const hoursUntilReset = getHoursUntilReset();
    const availableForHistorical = dailyRemaining * (1 - WEBHOOK_RESERVE_PERCENT);
    const sustainableRequestsPerHour = availableForHistorical / hoursUntilReset;
    const sustainableRequestsPerRun = sustainableRequestsPerHour / RUNS_PER_HOUR;

    // Each activity requires ~2 API calls (activity detail + streams)
    const sustainableActivitiesPerRun = sustainableRequestsPerRun / 2;

    // Also respect short-term limit (per 15-minute window)
    // Leave buffer of 10 requests for safety
    const shortTermActivities = Math.floor((shortTermRemaining - 10) / 2);

    // Take the minimum of sustainable rate and short-term allowance
    const allowance = Math.min(
        Math.floor(sustainableActivitiesPerRun),
        shortTermActivities
    );

    console.log("Rate limit calculation", {
        dailyRemaining,
        shortTermRemaining,
        hoursUntilReset: hoursUntilReset.toFixed(2),
        sustainableActivitiesPerRun: sustainableActivitiesPerRun.toFixed(2),
        shortTermActivities,
        allowance,
    });

    // Always allow at least 1 activity if we have capacity
    return Math.max(allowance, dailyRemaining >= 2 ? 1 : 0);
};

export default checkRateLimit;
