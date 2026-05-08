const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper to convert local file to generative part
function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
      mimeType
    },
  };
}

async function verifyIdCard(filePath, mimeType) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });

    const prompt = `
      Analyze this image and determine if it is a valid Philippine Senior Citizen ID or PWD ID.
      Check for the following:
      1. Is this a photo of a physical ID card?
      2. Does it contain a person's name, photo, and ID number?
      3. Does it mention the issuing government agency (e.g., OSCA, NCDA)?
      4. Does it appear to be genuine and not digitally fabricated or a random image?

      Respond strictly in JSON format with the following structure:
      {
        "isValid": true/false,
        "confidence": "high"/"medium"/"low",
        "cardType": "senior_citizen_id"/"pwd_id"/"unknown",
        "detectedFields": ["name", "photo", "id_number", "agency"],
        "reason": "Brief explanation of your assessment"
      }
    `;

    const imagePart = fileToGenerativePart(filePath, mimeType);

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();

    // Clean up potential markdown formatting from JSON
    const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();

    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw new Error("Failed to verify ID card with AI.");
  }
}

async function generateChatResponse(message, history) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      systemInstruction: `You are the official AI Customer Service Assistant for Kape Kanto Hub, a local coffee shop in the Philippines.
You are helpful, polite, and concise.

Store Information:
- Open Monday to Sunday, 7:00 AM to 10:00 PM.
- Address: 123 Kanto St., Manila, Philippines.
- We offer coffee (Hot & Iced), Pastries, Meals, and Frappes.
- We accept Cash on Delivery (COD), GCash, and Credit/Debit Cards via PayRex.
- We offer a 20% discount for registered Senior Citizens and PWDs (requires ID upload in profile).

If you are asked a question you don't know the answer to, politely explain that you are an AI assistant and they can contact our human support at benchrafael2@gmail.com.
Keep responses short and well-formatted.`
    });

    // Format history for Gemini
    const formattedHistory = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }]
    }));

    const chat = model.startChat({
      history: formattedHistory
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Gemini Chat Error:", error.message || error);
    if (error.status === 403) {
      throw new Error("API key invalid or expired. Please check your Gemini API key.");
    } else if (error.status === 429) {
      throw new Error("Rate limit exceeded. Please try again in a moment.");
    } else if (error.status === 500) {
      throw new Error("Gemini API server error. Please try again later.");
    }
    throw new Error("Failed to generate chatbot response. " + (error.message || "Unknown error"));
  }
}

module.exports = {
  verifyIdCard,
  generateChatResponse
};
