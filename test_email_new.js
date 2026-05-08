require('dotenv').config();
const { sendVerificationEmail } = require('./services/email');

async function test() {
    console.log("Testing email with user credentials...");
    try {
        await sendVerificationEmail('benchrafael2@gmail.com', '123456');
        console.log("SUCCESS: Verification email sent to benchrafael2@gmail.com");
    } catch (e) {
        console.error("FAILED to send email:", e);
    }
}

test();
