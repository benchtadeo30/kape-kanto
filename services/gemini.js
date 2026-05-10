const fs = require("fs");

// OpenRouter API Configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
        model: "google/gemini-2.0-flash-001", // Reverted to high-quality vision model
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
    // Build system instruction with full site knowledge
    const systemInstruction = `You are the official AI Customer Service Assistant for Kape Kanto Hub. 
Your primary goal is to help users navigate our website and answer questions about our shop.

STRICT SCOPE:
- Only answer questions related to Kape Kanto Hub.
- If a user asks about general knowledge, other businesses, or unrelated topics, politely decline and steer them back to Kape Kanto Hub.
- Do not provide code, medical advice, or personal opinions.

KAPE KANTO HUB FEATURES:
1. Ordering: Customers can browse the /menu, add items to their Cart, and choose between Pickup or Delivery.
2. 20% Discount: Senior Citizens and PWDs can upload their ID in the /profile page. Our AI verifies it instantly to apply a 20% discount.
3. Security: All sensitive account changes (updating username, changing password, removing email) require a 6-digit security code sent to your Gmail for protection.
4. Promos: Check the "Limited Time Events" on the Home page for active deals and live countdowns.
5. Loyalty: Join "Loyalty Tasks" in your Profile to earn rewards by completing specific challenges.
6. Support: For human assistance, email benchrafael2@gmail.com.

SHOP INFO:
- Hours: Mon-Sun, 7:00 AM - 10:00 PM.
- Address: 123 Kanto St., Manila, Philippines.
- Menu: Coffee (Hot/Iced), Pastries, Meals, and Frappes.
- Payments: COD, GCash, and Credit/Debit Cards via PayRex.

Keep your responses professional, friendly, and very concise. Use bullet points if listing steps.`;

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
    'help': 'I can help with questions about our menu, 20% Senior/PWD discounts, and account security. What would you like to know?',
    'contact': 'You can reach our human support team at benchrafael2@gmail.com.',
    'hours': 'We are open Monday to Sunday, 7:00 AM to 10:00 PM.'
  };

  const lower = message.toLowerCase();
  for (const [keyword, response] of Object.entries(responses)) {
    if (lower.includes(keyword)) return response;
  }

  return "I'm sorry, I'm having trouble connecting to my brain right now! Please email benchrafael2@gmail.com for assistance.";
}

module.exports = {
  verifyIdCard,
  generateChatResponse
};