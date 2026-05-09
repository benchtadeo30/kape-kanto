const fs = require("fs");

// OpenRouter API Configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Simple FAQ map for site‑specific queries
const siteFaq = {
  "login": "To log in, go to /login, enter the email you used to register and your password, then click the 'Sign In' button. If you forgot your password, click the 'Forgot password?' link to receive a reset email.",
  "log in": "To log in, go to /login, enter your email and password, and click 'Sign In'. Use 'Forgot password?' if needed.",
  "sign in": "Visit /login, input your email and password, then press 'Sign In'. Use the 'Forgot password?' link for resets.",
  "register": "To create an account, visit /register, fill in your name, email, and a password, then submit. You'll receive a verification email.",
  "sign up": "Go to /register, provide your name, email and password, then submit. Verify via the email we send you.",
  "reset password": "On the login page, click 'Forgot password?', enter your email, and follow the link we send to set a new password.",
  "forgot password": "Click 'Forgot password?' on the login page, enter your email, and follow the instructions in the email to reset your password."
};

function getSiteAnswer(message) {
  const lower = message.toLowerCase();
  for (const [key, answer] of Object.entries(siteFaq)) {
    if (lower.includes(key)) return answer;
  }
  return null;
}

async function verifyIdCard(filePath, mimeType, expectedType) {
  try {
    // Read and encode image to base64
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeTypeStr = mimeType || 'image/jpeg';
    const base64Data = `data:${mimeTypeStr};base64,${base64Image}`;

    const typeLabel = expectedType === 'senior' ? 'Philippine Senior Citizen ID' : 'Philippine PWD ID';

    const prompt = `Analyze this image and determine if it is a valid ${typeLabel}.
Check for the following:
1. Is this a photo of a physical ID card?
2. Does it contain a person's name, photo, and ID number?
3. Does it mention the issuing government agency (e.g., OSCA, NCDA)?
4. Does it appear to be genuine and not digitally fabricated?
5. Most importantly: Is it specifically a ${typeLabel}?

Respond strictly in JSON format with the following structure:
{
  "isValid": true/false,
  "confidence": "high"/"medium"/"low",
  "detectedCardType": "senior_citizen_id"/"pwd_id"/"unknown",
  "isExpectedType": true/false,
  "reason": "A clear, polite message explaining why the ID was accepted or rejected. If rejected, specifically mention that the ${typeLabel} verification failed."
}`;

    // Following OpenRouter multi-part message format
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt
          },
          {
            type: "image_url",
            image_url: {
              url: base64Data
            }
          }
        ]
      }
    ];

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.BASE_URL || "https://kapekantohub.com",
        "X-Title": "Kape Kanto Hub ID Verification"
      },
      body: JSON.stringify({
        model: "openrouter/free", // Corrected to a VISION-capable free model
        messages: messages,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content;
    const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleanJson);

  } catch (error) {
    console.error("OpenRouter Vision ID verification error:", error);
    throw new Error("ID verification AI failed. Please ensure the image is clear and try again.");
  }
}

async function generateChatResponse(message, history) {
  try {
    // First, see if we have a site‑specific FAQ answer
    const siteAnswer = getSiteAnswer(message);
    if (siteAnswer) {
      return siteAnswer;
    }

    // Build system instruction
    const systemInstruction = `You are the official AI Customer Service Assistant for Kape Kanto Hub, a local coffee shop in the Philippines.
You are helpful, polite, and concise.

Store Information:
- Open Monday to Sunday, 7:00 AM to 10:00 PM.
- Address: 123 Kanto St., Manila, Philippines.
- We offer coffee (Hot & Iced), Pastries, Meals, and Frappes.
- We accept Cash on Delivery (COD), GCash, and Credit/Debit Cards via PayRex.
- We offer a 20% discount for registered Senior Citizens and PWDs (requires ID upload in profile).

If you are asked a question you don't know the answer to, politely explain that you are an AI assistant and they can contact our human support at benchrafael2@gmail.com.
Keep responses short and well-formatted.${siteAnswer ? "\nFAQ Answer: " + siteAnswer : ""}`;

    // Build messages for OpenRouter
    const messages = [
      { role: "system", content: systemInstruction },
      ...history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.text
      })),
      { role: "user", content: message }
    ];

    // Call OpenRouter API
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.BASE_URL || "https://kapekantohub.com",
        "X-Title": "Kape Kanto Hub Chatbot"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b:free",
        messages: messages,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 429) {
        return "I'm experiencing high demand right now. Please try again in a few moments, or contact our support at benchrafael2@gmail.com for immediate assistance.";
      }
      throw new Error(`OpenRouter API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;

  } catch (error) {
    console.error("OpenRouter Chat Error:", error.message || error);
    return getFallbackResponse(message.toLowerCase());
  }
}

function getFallbackResponse(message) {
  const responses = {
    'hello': 'Hello! Welcome to Kape Kanto Hub. How may I help you today?',
    'hi': 'Hi there! Welcome to Kape Kanto Hub. What can I do for you?',
    'hey': 'Hey! Welcome to our coffee shop. How can I assist you?',
    'hours': 'We\'re open Monday to Sunday, 7:00 AM to 10:00 PM. Come visit us!',
    'open': 'We\'re open Monday to Sunday, 7:00 AM to 10:00 PM. Come visit us!',
    'time': 'We\'re open Monday to Sunday, 7:00 AM to 10:00 PM. Come visit us!',
    'location': 'We\'re located at 123 Kanto St., Manila, Philippines. Find us on Google Maps!',
    'address': 'Our address is 123 Kanto St., Manila, Philippines.',
    'where': 'We\'re at 123 Kanto St., Manila, Philippines. Easy to find!',
    'menu': 'We offer hot & iced coffee, pastries, meals, and delicious frappes. Check our menu page for full details!',
    'coffee': 'We have amazing hot and iced coffee options including our signature Kanto Americano, lattes, cappuccinos, and more!',
    'food': 'Our menu includes pastries like croissants and cookies, plus meals like beef tapa bowls and chicken adobo.',
    'payment': 'We accept Cash on Delivery (COD), GCash, and Credit/Debit Cards via PayRex.',
    'pay': 'We accept Cash on Delivery (COD), GCash, and Credit/Debit Cards via PayRex.',
    'discount': 'We offer 20% discount for registered Senior Citizens and PWDs. Upload your ID in your profile to get verified!',
    'senior': 'Senior Citizens get 20% discount! Upload your Senior Citizen ID in your profile to get verified.',
    'pwd': 'PWD card holders get 20% discount! Upload your PWD ID in your profile to get verified.',
    'contact': 'You can reach our human support at benchrafael2@gmail.com for any questions.',
    'help': 'I\'m here to help! For complex questions, contact our human support at benchrafael2@gmail.com.',
    'support': 'For additional support, please email benchrafael2@gmail.com.'
  };

  for (const [keyword, response] of Object.entries(responses)) {
    if (message.includes(keyword)) {
      return response;
    }
  }

  return "Thanks for your message! I'm a simple chatbot right now. For detailed assistance, please email benchrafael2@gmail.com or check our Help Center.";
}

module.exports = {
  verifyIdCard,
  generateChatResponse
};