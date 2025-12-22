import checkRateLimit from "./checkRateLimit";
import getNumberOfMessages from "./getNumberOfMessages";
import getMostRecentMessage from "./getMostRecentMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";
import QueueMessage from "../typeDefs/QueueMessage";

/**
 * Count pending webhook messages (priority = 1, is_webhook = true)
 * These should always be processed immediately for real-time user experience.
 */
const getWebhookCount = async (): Promise<number> => {
    const pool = await getCloudSqlConnection();

    const { rows } = await pool.query<{ count: string }>(`
        SELECT COUNT(id) count FROM event_queue
        WHERE started IS NULL 
          AND completed IS NULL 
          AND is_webhook = true
          AND attempts < 5
    `);

    return parseInt(rows[0].count, 10);
};

/**
 * Get messages to process with webhook priority.
 *
 * Strategy:
 * 1. Always process ALL pending webhooks immediately (burst mode)
 *    - These are real-time activities the user just uploaded
 *    - Critical for the "magic moment" of seeing summits detected immediately
 *
 * 2. Apply sustainable rate limit only to historical activities
 *    - Historical imports spread throughout the day
 *    - Ensures we never run out of API quota for webhooks
 *
 * The queue already orders by priority ASC (webhooks = 1, historical = 100+),
 * so webhooks will always be fetched first.
 */
const getMessagesToProcess = async () => {
    // Get sustainable allowance for historical activities
    const historicalAllowance = await checkRateLimit(false);

    // Count pending webhooks
    const webhookCount = await getWebhookCount();

    // Total pending messages
    const totalMessages = await getNumberOfMessages();

    // Calculate how many to process:
    // - All webhooks (burst)
    // - Plus sustainable historical allowance
    // But cap at total pending and max 50 per run for safety
    const messagesToProcess = Math.min(
        50, // Safety cap per run
        totalMessages,
        webhookCount + historicalAllowance
    );

    console.log("Messages to process", {
        webhookCount,
        historicalAllowance,
        totalMessages,
        messagesToProcess,
    });

    if (messagesToProcess === 0) {
        console.log("No messages to process");
        return [];
    }

    const messages: QueueMessage[] = [];
    await getMostRecentMessage(messagesToProcess, (messageList) => {
        messages.push(...messageList);
    });

    // Log breakdown of what we're processing
    const webhooksInBatch = messages.filter((m) => m.is_webhook).length;
    const historicalInBatch = messages.filter((m) => !m.is_webhook).length;
    console.log(
        `Processing ${webhooksInBatch} webhooks + ${historicalInBatch} historical`
    );

    return messages;
};

export default getMessagesToProcess;
