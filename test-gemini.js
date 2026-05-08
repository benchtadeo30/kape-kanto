require('dotenv').config();
const { generateChatResponse } = require('./services/gemini');

async function test() {
    try {
        const reply = await generateChatResponse("Hello", []);
        console.log("Success! Reply:", reply);
    } catch (error) {
        console.error("Test Failed:", error);
    }
}

test();

test();
