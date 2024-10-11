import checkRateLimit from "./checkRateLimit";
import getCloudSqlConnection from "./getCloudSqlConnection";
import resetShortTermUsage from "./resetShortTermUsage";
import retrieveMessage from "./retrieveMessage";

const processMessages = async () => {
    console.log("processing messages");

    const connection = await getCloudSqlConnection();

    await resetShortTermUsage(connection);

    let moreMessages = true;
    while ((await checkRateLimit(connection)) && moreMessages) {
        moreMessages = await retrieveMessage(connection);
    }

    console.log(
        moreMessages ? "Rate limit reached" : "No more messages to process"
    );
};

export default processMessages;
