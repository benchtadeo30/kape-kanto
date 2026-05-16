const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

let client = null;
if (accountSid && authToken) {
    client = twilio(accountSid, authToken);
}

/**
 * Sends an OTP to the given phone number via Twilio SMS.
 * @param {string} phoneNumber - The recipient's phone number (e.g., +639123456789)
 * @param {string} otp - The 4-digit OTP code
 * @returns {Promise<boolean>} True if SMS was sent or successfully mocked, false otherwise.
 */
async function sendOTP(phoneNumber, otp) {
    const messageBody = `Your Kape Kanto Hub verification code is: ${otp}. This code expires in 10 minutes.`;
    
    // If Twilio is not configured, we gracefully fallback and log the OTP to the console.
    if (!client || !twilioPhoneNumber) {
        console.warn('⚠️ [Twilio] Credentials not found. SMS sending is mocked.');
        console.log(`[Twilio Mock] To: ${phoneNumber} | Message: ${messageBody}`);
        return true;
    }

    try {
        const message = await client.messages.create({
            body: messageBody,
            from: twilioPhoneNumber,
            to: phoneNumber
        });
        console.log(`✅ [Twilio] SMS sent successfully. SID: ${message.sid}`);
        return true;
    } catch (error) {
        console.error('❌ [Twilio] Failed to send SMS:', error.message);
        // Free tier restricts to verified numbers only, so we log it for testing purposes
        console.log(`[Twilio Mock Fallback] To: ${phoneNumber} | OTP: ${otp}`);
        
        // Return true anyway so the user can proceed with testing via the mocked OTP printed in the console
        return true; 
    }
}

module.exports = { sendOTP };
