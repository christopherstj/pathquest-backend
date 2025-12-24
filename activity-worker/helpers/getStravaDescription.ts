import getCloudSqlConnection from "./getCloudSqlConnection";

type ClimbingStreak = {
    currentStreak: number;
    isActive: boolean;
    lastSummitMonth: string | null;
};

type ChallengeProgressRow = {
    challenge_id: number;
    challenge_name: string;
    total: number;
    completed: number;
};

type PeakStatsRow = {
    name: string;
    elevation: number | null;
    state: string | null;
    country: string | null;
    lifetime_summits: number;
    prior_summits: number;
};

const metersToFeetRounded = (meters: number) => Math.round(meters * 3.28084);

const calculateMonthlyStreak = (summitMonths: Date[]): ClimbingStreak => {
    // Ported from `pathquest-api/src/helpers/user/getUserProfileStats.ts`
    // (same "consecutive months with at least 1 summit" logic).
    let currentStreak = 0;
    let isActive = false;
    let lastSummitMonth: string | null = null;

    if (summitMonths.length > 0) {
        const now = new Date();
        const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

        // Check if the most recent summit is from current or last month
        const mostRecentSummit = new Date(summitMonths[0]);
        const mostRecentMonth = new Date(
            mostRecentSummit.getFullYear(),
            mostRecentSummit.getMonth(),
            1
        );

        // Streak is active if most recent summit is in current month
        isActive = mostRecentMonth.getTime() === currentMonth.getTime();
        lastSummitMonth = mostRecentMonth.toISOString();

        // Calculate streak - must be consecutive months starting from current or last month
        if (mostRecentMonth.getTime() >= lastMonth.getTime()) {
            let expectedMonth = mostRecentMonth;

            for (const summitMonthDate of summitMonths) {
                const summitMonth = new Date(summitMonthDate);
                const summitMonthStart = new Date(
                    summitMonth.getFullYear(),
                    summitMonth.getMonth(),
                    1
                );

                if (summitMonthStart.getTime() === expectedMonth.getTime()) {
                    currentStreak++;
                    // Move to previous month
                    expectedMonth = new Date(
                        expectedMonth.getFullYear(),
                        expectedMonth.getMonth() - 1,
                        1
                    );
                } else if (summitMonthStart.getTime() < expectedMonth.getTime()) {
                    // Gap found, streak broken
                    break;
                }
            }
        }
    }

    return { currentStreak, isActive, lastSummitMonth };
};

const getHighestPreviousPeakElevationMeters = async (params: {
    pool: Awaited<ReturnType<typeof getCloudSqlConnection>>;
    userId: string;
    currentActivityId: string;
}): Promise<number | null> => {
    const { pool, userId, currentActivityId } = params;

    const query = `
        WITH user_summits AS (
            SELECT ap.peak_id, ap.activity_id::text as activity_id
            FROM activities_peaks ap
            LEFT JOIN activities a ON a.id = ap.activity_id
            WHERE a.user_id = $1
              AND COALESCE(ap.confirmation_status, 'auto_confirmed') != 'denied'
            UNION ALL
            SELECT peak_id, activity_id::text as activity_id
            FROM user_peak_manual
            WHERE user_id = $1
        ),
        previous_peaks AS (
            SELECT DISTINCT peak_id
            FROM user_summits
            WHERE activity_id IS NULL OR activity_id != $2
        )
        SELECT MAX(p.elevation)::numeric AS max_elevation
        FROM previous_peaks pp
        LEFT JOIN peaks p ON pp.peak_id = p.id
        WHERE p.elevation IS NOT NULL
    `;

    const { rows } = await pool.query<{ max_elevation: string | null }>(query, [
        userId,
        currentActivityId,
    ]);

    const raw = rows[0]?.max_elevation ?? null;
    return raw === null ? null : parseFloat(raw);
};

const getPreviousStatesAndCountries = async (params: {
    pool: Awaited<ReturnType<typeof getCloudSqlConnection>>;
    userId: string;
    currentActivityId: string;
}): Promise<{ states: Set<string>; countries: Set<string> }> => {
    const { pool, userId, currentActivityId } = params;

    const query = `
        WITH user_summits AS (
            SELECT ap.peak_id, ap.activity_id::text as activity_id
            FROM activities_peaks ap
            LEFT JOIN activities a ON a.id = ap.activity_id
            WHERE a.user_id = $1
              AND COALESCE(ap.confirmation_status, 'auto_confirmed') != 'denied'
            UNION ALL
            SELECT peak_id, activity_id::text as activity_id
            FROM user_peak_manual
            WHERE user_id = $1
        ),
        previous_peaks AS (
            SELECT DISTINCT peak_id
            FROM user_summits
            WHERE activity_id IS NULL OR activity_id != $2
        )
        SELECT DISTINCT p.state, p.country
        FROM previous_peaks pp
        LEFT JOIN peaks p ON pp.peak_id = p.id
        WHERE p.state IS NOT NULL OR p.country IS NOT NULL
    `;

    const { rows } = await pool.query<{ state: string | null; country: string | null }>(
        query,
        [userId, currentActivityId]
    );

    const states = new Set<string>();
    const countries = new Set<string>();

    for (const r of rows) {
        if (r.state) states.add(r.state);
        if (r.country) countries.add(r.country);
    }

    return { states, countries };
};

const getPeakStats = async (params: {
    pool: Awaited<ReturnType<typeof getCloudSqlConnection>>;
    userId: string;
    peakId: string;
    currentActivityId: string;
}): Promise<PeakStatsRow | null> => {
    const { pool, userId, peakId, currentActivityId } = params;

    // Count prior summits excluding this activity to detect "first time summiting a peak"
    const peakStatsQuery = `
        WITH user_summits AS (
            SELECT ap.peak_id, ap.activity_id::text as activity_id, ap.timestamp
            FROM activities_peaks ap
            LEFT JOIN activities a ON a.id = ap.activity_id
            WHERE a.user_id = $1
              AND COALESCE(ap.confirmation_status, 'auto_confirmed') != 'denied'
            UNION ALL
            SELECT peak_id, activity_id::text as activity_id, timestamp
            FROM user_peak_manual
            WHERE user_id = $1
        )
        SELECT 
            p.name,
            p.elevation,
            p.state,
            p.country,
            COUNT(*)::int AS lifetime_summits,
            COUNT(*) FILTER (WHERE user_summits.activity_id IS NULL OR user_summits.activity_id != $2)::int AS prior_summits
        FROM user_summits
        LEFT JOIN peaks p ON user_summits.peak_id = p.id
        WHERE user_summits.peak_id = $3
        GROUP BY p.name, p.elevation, p.state, p.country
    `;

    const { rows } = await pool.query<PeakStatsRow>(peakStatsQuery, [
        userId,
        currentActivityId,
        peakId,
    ]);

    return rows[0] ?? null;
};

const getChallengeProgressByPeak = async (params: {
    pool: Awaited<ReturnType<typeof getCloudSqlConnection>>;
    userId: string;
    peakId: string;
}): Promise<ChallengeProgressRow[]> => {
    const { pool, userId, peakId } = params;

    const challengeProgressQuery = `
        WITH user_peaks AS (
            SELECT DISTINCT peak_id
            FROM (
                SELECT ap.peak_id
                FROM activities_peaks ap
                LEFT JOIN activities a ON a.id = ap.activity_id
                WHERE a.user_id = $1
                  AND COALESCE(ap.confirmation_status, 'auto_confirmed') != 'denied'
                UNION
                SELECT peak_id
                FROM user_peak_manual
                WHERE user_id = $1
            ) t
        ),
        challenges_for_peak AS (
            SELECT c.id, c.name
            FROM peaks_challenges pc
            LEFT JOIN challenges c ON pc.challenge_id = c.id
            WHERE pc.peak_id = $2
        )
        SELECT 
            cfp.id::int AS challenge_id,
            cfp.name AS challenge_name,
            COUNT(pc2.peak_id)::int AS total,
            COUNT(up.peak_id)::int AS completed
        FROM challenges_for_peak cfp
        LEFT JOIN peaks_challenges pc2 ON pc2.challenge_id = cfp.id
        LEFT JOIN user_peaks up ON up.peak_id = pc2.peak_id
        GROUP BY cfp.id, cfp.name
        HAVING COUNT(pc2.peak_id) > 0
        ORDER BY completed DESC, total DESC, cfp.name ASC
    `;

    return (await pool.query<ChallengeProgressRow>(challengeProgressQuery, [
        userId,
        peakId,
    ])).rows;
};

const getStravaDescription = async (
    userId: string,
    previousDescription: string,
    summits: {
        peakId: string;
        timestamp: Date;
        activityId: number;
    }[]
) => {
    if (summits.length === 0) {
        return;
    }

    const pool = await getCloudSqlConnection();

    const { rows: userRows } = await pool.query<{
        update_description: boolean;
    }>("SELECT update_description FROM users WHERE id = $1", [userId]);

    const updateDescription = Boolean(userRows[0].update_description);

    if (!updateDescription) {
        return;
    }

    const mountainsSummited = summits.reduce(
        (
            prev,
            curr
        ): {
            id: string;
            activitySummits: number;
        }[] => {
            const existing = prev.find((x) => x.id === curr.peakId);
            if (existing) {
                existing.activitySummits++;
            } else {
                prev.push({
                    id: curr.peakId,
                    activitySummits: 1,
                });
            }
            return prev;
        },
        [] as {
            id: string;
            activitySummits: number;
        }[]
    );

    // --- Streak calculation (same algorithm as profile stats) ---
    const streakQuery = `
        WITH user_summits AS (
            SELECT ap.timestamp
            FROM (
                SELECT a.user_id, ap.timestamp
                FROM activities_peaks ap
                LEFT JOIN activities a ON a.id = ap.activity_id
                WHERE COALESCE(ap.confirmation_status, 'auto_confirmed') != 'denied'
                UNION
                SELECT user_id, timestamp
                FROM user_peak_manual
            ) ap
            WHERE ap.user_id = $1
        ),
        monthly_summits AS (
            SELECT DISTINCT
                DATE_TRUNC('month', timestamp) AS month
            FROM user_summits
            ORDER BY month DESC
        )
        SELECT 
            ARRAY_AGG(month ORDER BY month DESC) AS months
        FROM monthly_summits
    `;

    const streakResult = await pool.query<{ months: Date[] }>(streakQuery, [
        userId,
    ]);
    const summitMonths: Date[] = streakResult.rows[0]?.months || [];
    const climbingStreak = calculateMonthlyStreak(summitMonths);

    // Show streak message only when this activity *extends* the streak this month:
    // - streak is active (has a summit in current month),
    // - streak is at least 2 months (meaning last month was also summited),
    // - and this activity is the first summitting activity in the current month (to avoid spam).
    const currentActivityId = summits[0].activityId;
    const monthFirstSummitQuery = `
        WITH other_summits AS (
            SELECT ap.timestamp
            FROM (
                SELECT a.user_id, ap.timestamp, ap.activity_id::text as activity_id
                FROM activities_peaks ap
                LEFT JOIN activities a ON a.id = ap.activity_id
                WHERE COALESCE(ap.confirmation_status, 'auto_confirmed') != 'denied'
                UNION
                SELECT user_id, timestamp, activity_id::text as activity_id
                FROM user_peak_manual
            ) ap
            WHERE ap.user_id = $1
              AND DATE_TRUNC('month', ap.timestamp) = DATE_TRUNC('month', NOW())
              AND (ap.activity_id IS NULL OR ap.activity_id != $2)
        )
        SELECT COUNT(*)::int AS count
        FROM other_summits
    `;

    const { rows: monthCountRows } = await pool.query<{ count: number }>(
        monthFirstSummitQuery,
        [userId, currentActivityId.toString()]
    );
    const otherSummitsThisMonth = monthCountRows[0]?.count ?? 0;
    const showStreakExtension =
        climbingStreak.isActive &&
        climbingStreak.currentStreak >= 2 &&
        otherSummitsThisMonth === 0;

    const currentActivityIdString = currentActivityId.toString();

    // --- Per-peak details and challenge progress ---
    const peakPromises = mountainsSummited.map(async (summit) => {
        const peakStats = await getPeakStats({
            pool,
            userId,
            peakId: summit.id,
            currentActivityId: currentActivityIdString,
        });

        const isFirstSummit = (peakStats?.prior_summits ?? 0) === 0;

        // Challenge progress only makes sense on first summit of that peak (new progress).
        const challenges = isFirstSummit
            ? await getChallengeProgressByPeak({
                  pool,
                  userId,
                  peakId: summit.id,
              })
            : [];

        return {
            id: summit,
            name: peakStats?.name ?? summit.id,
            elevation: peakStats?.elevation ?? undefined,
            state: peakStats?.state ?? undefined,
            country: peakStats?.country ?? undefined,
            activitySummits: summit.activitySummits,
            lifetimeSummits: peakStats?.lifetime_summits ?? summit.activitySummits,
            isFirstSummit,
            challenges,
        };
    });

    const data = await Promise.all(peakPromises);

    // Determine if this activity sets a new personal record for highest peak
    const previousMaxElevationMeters = await getHighestPreviousPeakElevationMeters({
        pool,
        userId,
        currentActivityId: currentActivityIdString,
    });

    const activityMax = data
        .filter((x) => typeof x.elevation === "number")
        .sort((a, b) => (b.elevation ?? -Infinity) - (a.elevation ?? -Infinity))[0];

    const newHighestPeakId =
        activityMax?.elevation != null &&
        (previousMaxElevationMeters == null ||
            activityMax.elevation > previousMaxElevationMeters)
            ? activityMax.id.id
            : null;

    // Determine state/country unlocks (exclude current activity)
    const previousPlaces = await getPreviousStatesAndCountries({
        pool,
        userId,
        currentActivityId: currentActivityIdString,
    });
    const mentionedPlaceUnlocks = new Set<string>();

    // NOTE: Streak logic is intentionally NOT included in the Strava description output
    // (kept here for potential future re-enable).
    void showStreakExtension;
    void climbingStreak;

    const peaksSection = data
        .map((mountain) => {
            const elevationTag =
                typeof mountain.elevation === "number"
                    ? ` (${metersToFeetRounded(mountain.elevation).toLocaleString()} ft)`
                    : "";

            const firstSummitTag = mountain.isFirstSummit ? " - first summit! 🎉" : "";

            const newHighestTag =
                newHighestPeakId && mountain.id.id === newHighestPeakId
                    ? " ⭐ New highest peak!"
                    : "";
            const activitySummitsTag =
                mountain.activitySummits > 1
                    ? ` - ${mountain.activitySummits} summits`
                    : "";

            const lifetimeTag = mountain.isFirstSummit
                ? ""
                : ` (${mountain.lifetimeSummits} lifetime summit${
                      mountain.lifetimeSummits !== 1 ? "s" : ""
                  })`;

            const peakLine = `${mountain.name}${elevationTag}${activitySummitsTag}${lifetimeTag}${firstSummitTag}${newHighestTag}`;

            // Place unlock line (only for new progress: first time summiting this peak)
            let placeUnlockLine = "";
            if (mountain.isFirstSummit) {
                const state = mountain.state?.trim();
                const country = mountain.country?.trim();

                if (state && !previousPlaces.states.has(state)) {
                    const key = `state:${state}`;
                    if (!mentionedPlaceUnlocks.has(key)) {
                        mentionedPlaceUnlocks.add(key);
                        placeUnlockLine = `  🏳️ First peak in ${state}!`;
                    }
                } else if (country && !previousPlaces.countries.has(country)) {
                    const key = `country:${country}`;
                    if (!mentionedPlaceUnlocks.has(key)) {
                        mentionedPlaceUnlocks.add(key);
                        placeUnlockLine = `  🏳️ First peak in ${country}!`;
                    }
                }
            }

            const challengeLines = mountain.challenges
                .map((c) => {
                    if (c.completed >= c.total) {
                        return `  🏆 ${c.challenge_name} COMPLETE!`;
                    }
                    return `  🗻 ${c.completed}/${c.total} ${c.challenge_name}`;
                })
                .join("\n");

            const subLines = [placeUnlockLine, challengeLines]
                .filter((x) => x && x.length > 0)
                .join("\n");

            return subLines ? `${peakLine}\n${subLines}` : peakLine;
        })
        .join("\n");

    const baseHeader = `⛰️ PathQuest.app\nMountains summited:\n`;
    const prefix = previousDescription ? `${previousDescription}\n\n` : "";
    const funHeader = "";

    return `${prefix}${funHeader}${baseHeader}${peaksSection}\n`;
};

export default getStravaDescription;
