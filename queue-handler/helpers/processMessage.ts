import dayjs from "dayjs";
import QueueMessage from "../typeDefs/QueueMessage";
import getCloudSqlConnection from "./getCloudSqlConnection";
import StravaEvent from "../typeDefs/StravaEvent";
import getStravaActivity from "./getStravaActivity";
import updateStravaDescription from "./updateStravaDescription";
import { Connection } from "mysql2/promise";

const processMessage = async (
    connection: Connection,
    message: QueueMessage
) => {
    console.log(`Processing message ${message.id}`);

    try {
        await connection.execute(
            `UPDATE EventQueue SET started = ? WHERE id = ?`,
            [dayjs().format("YYYY-MM-DD HH:mm:ss"), message.id]
        );

        if (!message.jsonData) return { success: false, error: "No JSON data" };

        const messageData: StravaEvent =
            typeof message.jsonData === "string"
                ? JSON.parse(message.jsonData)
                : message.jsonData;

        const description = await getStravaActivity(
            connection,
            messageData.object_id,
            messageData.owner_id.toString()
        );

        const isWebhook = message.isWebhook;

        if (isWebhook && description && description.length > 0) {
            console.log("Updating activity description");

            const success = updateStravaDescription(
                connection,
                messageData.owner_id.toString(),
                messageData.object_id,
                description
            );

            console.log(success);
        }

        return { success: true };
    } catch (err) {
        console.error(err);
        return { success: false, error: err as string };
    }
};

export default processMessage;
