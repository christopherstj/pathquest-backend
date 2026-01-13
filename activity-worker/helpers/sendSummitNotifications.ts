/**
 * Send push notifications for auto-detected summits from Strava activity sync.
 * 
 * This is the appropriate place to notify users - when the system automatically
 * detects summits from their activities, not when they manually log summits.
 */

import getCloudSqlConnection from "./getCloudSqlConnection";

interface ExpoPushTicket {
    status: "ok" | "error";
    id?: string;
    message?: string;
    details?: {
        error?: string;
    };
}

interface SummitInput {
    peakId: string;
    timestamp: Date;
}

interface SummitWithName {
    peakId: string;
    peakName: string;
    timestamp: Date;
}

/**
 * Send push notifications for detected summits to a user.
 * Batches multiple summits into a single notification if needed.
 */
export async function sendSummitNotifications(
    userId: string,
    summits: SummitInput[]
): Promise<void> {
    if (!summits || summits.length === 0) return;

    const pool = await getCloudSqlConnection();
    
    // Look up peak names
    const peakIds = summits.map(s => s.peakId);
    const peakNamesResult = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM peaks WHERE id = ANY($1)`,
        [peakIds]
    );
    
    const peakNameMap = new Map(peakNamesResult.rows.map(r => [r.id, r.name]));
    
    const summitsWithNames: SummitWithName[] = summits.map(s => ({
        peakId: s.peakId,
        peakName: peakNameMap.get(s.peakId) || "Unknown Peak",
        timestamp: s.timestamp,
    }));

    try {
        // Check if user has summit notifications enabled
        const settingsResult = await pool.query(
            `SELECT summit_notifications_enabled FROM user_settings WHERE user_id = $1`,
            [userId]
        );

        if (settingsResult.rows.length > 0 && !settingsResult.rows[0].summit_notifications_enabled) {
            console.log(`[sendSummitNotifications] User ${userId} has summit notifications disabled`);
            return;
        }

        // Get user's push tokens
        const tokensResult = await pool.query(
            `SELECT token FROM user_push_tokens WHERE user_id = $1`,
            [userId]
        );

        const tokens: string[] = tokensResult.rows.map((row) => row.token);

        if (tokens.length === 0) {
            console.log(`[sendSummitNotifications] No push tokens for user ${userId}`);
            return;
        }

        // Build notification content
        let title: string;
        let body: string;
        let data: Record<string, unknown>;

        if (summitsWithNames.length === 1) {
            const summit = summitsWithNames[0];
            title = "🏔️ Summit Logged!";
            body = `You summited ${summit.peakName}!`;
            data = {
                type: "summit_logged",
                peakId: summit.peakId,
                peakName: summit.peakName,
            };
        } else {
            // Multiple summits - summarize
            const peakNames = summitsWithNames.slice(0, 3).map(s => s.peakName);
            const moreCount = summitsWithNames.length - 3;
            
            title = `🏔️ ${summitsWithNames.length} Summits Logged!`;
            body = moreCount > 0 
                ? `${peakNames.join(", ")} and ${moreCount} more!`
                : peakNames.join(", ");
            data = {
                type: "summits_logged",
                count: summitsWithNames.length,
                peakIds: summitsWithNames.map(s => s.peakId),
            };
        }

        // Build Expo push messages
        const messages = tokens.map((token) => ({
            to: token,
            sound: "default" as const,
            title,
            body,
            data,
        }));

        // Send to Expo Push API
        const response = await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Accept-Encoding": "gzip, deflate",
                "Content-Type": "application/json",
            },
            body: JSON.stringify(messages),
        });

        if (!response.ok) {
            console.error(`[sendSummitNotifications] Expo Push API error: ${response.status}`);
            return;
        }

        const result = await response.json();
        const tickets: ExpoPushTicket[] = result.data;

        // Handle any errors
        let successCount = 0;
        for (let i = 0; i < tickets.length; i++) {
            const ticket = tickets[i];
            if (ticket.status === "ok") {
                successCount++;
            } else {
                console.error(`[sendSummitNotifications] Push error:`, ticket.message);
                // Remove invalid tokens
                if (ticket.details?.error === "DeviceNotRegistered") {
                    await pool.query(
                        `DELETE FROM user_push_tokens WHERE token = $1`,
                        [tokens[i]]
                    );
                    console.log(`[sendSummitNotifications] Removed invalid token`);
                }
            }
        }

        console.log(`[sendSummitNotifications] Sent ${successCount}/${tokens.length} notifications for user ${userId} (${summitsWithNames.length} summits)`);
    } catch (error) {
        console.error(`[sendSummitNotifications] Failed to send notifications:`, error);
    }
}

export default sendSummitNotifications;

