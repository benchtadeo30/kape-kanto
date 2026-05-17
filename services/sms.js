const apiKey = process.env.TEXTBEE_API_KEY;
const deviceId = process.env.TEXTBEE_DEVICE_ID;

/**
 * Sends an OTP to the given phone number via TextBee SMS Gateway.
 * Automatically formats local PH numbers (09xx) to E.164 (+639xx).
 * 
 * @param {string} phoneNumber - The recipient's phone number
 * @param {string} otp - The 4-digit OTP code
 * @returns {Promise<Object>} Status object { success, mocked, otp, error }
 */
async function sendOTP(phoneNumber, otp) {
    const messageBody = `Your Kape Kanto Hub verification code is: ${otp}. This code expires in 10 minutes.`;

    // 1. Format Phone Number to E.164 (Philippine international format)
    let formattedNumber = phoneNumber.trim();
    if (formattedNumber.startsWith('0')) {
        formattedNumber = '+63' + formattedNumber.substring(1);
    } else if (!formattedNumber.startsWith('+')) {
        formattedNumber = '+' + formattedNumber;
    }

    // 2. If TextBee is not configured, fall back to mock mode gracefully
    if (!apiKey || !deviceId) {
        console.warn('⚠️ [TextBee] API Key or Device ID not found. SMS sending is mocked.');
        console.log(`[TextBee Mock] To: ${formattedNumber} | Message: ${messageBody}`);
        return { success: true, mocked: true, otp };
    }

    try {
        console.log(`[TextBee] Attempting to send SMS to ${formattedNumber} via device ${deviceId}...`);
        const response = await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${deviceId}/send-sms`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                recipients: [formattedNumber],
                message: messageBody
            })
        });

        const data = await response.json();

        if (response.ok) {
            console.log(`✅ [TextBee] SMS sent successfully. Msg ID: ${data.messageId || 'N/A'}`);
            return { success: true, mocked: false };
        } else {
            console.error('❌ [TextBee] Gateway returned error:', data);
            throw new Error(data.message || 'Gateway error');
        }
    } catch (error) {
        console.error('❌ [TextBee] Failed to send SMS:', error.message);
        console.log(`[TextBee Mock Fallback] To: ${formattedNumber} | OTP: ${otp}`);
        return { success: true, mocked: true, otp, error: error.message };
    }
}

module.exports = { sendOTP };
