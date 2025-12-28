const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = "gemini-flash-lite-latest";
const SYS_INSTR = "You are gemini-flash-lite-latest, a large language model developed by Google. You are helpful, harmless, and honest. Always identify yourself as Gemini when asked about your identity."


/**
 * Продовжити розмову з Gemini
 */
async function continueConversation(userMessage, conversationHistory = []) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: GEMINI_MODEL,
      systemInstruction: SYS_INSTR
    });

    // Конвертувати історію в формат Gemini
    const history = conversationHistory.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const chat = model.startChat({ history });
    
    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    const text = response.text();

    return {
      success: true,
      text: text
    };
  } catch (error) {
    console.error('Gemini API error:', error);
    return {
      success: false,
      error: error.message || 'Failed to get response from Gemini'
    };
  }
}

/**
 * Аналіз зображення з Gemini
 */
async function analyzeImage(imageBase64, prompt, mimeType = 'image/jpeg') {
  try {
    const model = genAI.getGenerativeModel({ 
      model: GEMINI_MODEL,
      systemInstruction: SYS_INSTR });

    const imageParts = [
      {
        inlineData: {
          data: imageBase64,
          mimeType: mimeType
        }
      }
    ];

    const result = await model.generateContent([prompt, ...imageParts]);
    const response = await result.response;
    const text = response.text();

    return {
      success: true,
      text: text
    };
  } catch (error) {
    console.error('Gemini Vision API error:', error);
    return {
      success: false,
      error: error.message || 'Failed to analyze image with Gemini'
    };
  }
}

module.exports = {
  continueConversation,
  analyzeImage
};