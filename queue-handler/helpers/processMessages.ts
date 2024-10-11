import checkRateLimit from "./checkRateLimit";
import resetShortTermUsage from "./resetShortTermUsage";
import retrieveMessage from "./retrieveMessage";

const processMessages = async () => {
    console.log("processing messages");

    await resetShortTermUsage();

    let moreMessages = true;
    while ((await checkRateLimit()) && moreMessages) {
        moreMessages = await retrieveMessage();
    }

    console.log(
        moreMessages ? "Rate limit reached" : "No more messages to process"
    );
};

export default processMessages;
