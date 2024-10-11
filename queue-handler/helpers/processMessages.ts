import checkRateLimit from "./checkRateLimit";
import resetShortTermUsage from "./resetShortTermUsage";
import retrieveMessage from "./retrieveMessage";

const processMessages = async () => {
    console.log("processing messages");

    await resetShortTermUsage();

    while (await checkRateLimit()) {
        await retrieveMessage();
    }
};
