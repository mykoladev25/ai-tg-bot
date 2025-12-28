const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Чат з Claude (текстові повідомлення)
 */
async function chatWithClaude(message, conversationHistory = []) {
  try {
    const messages = [
      ...conversationHistory,
      {
        role: 'user',
        content: message
      }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      system: `Ти Claude Sonnet 4.5 - найновіша модель від Anthropic (claude-sonnet-4-20250514).
Якщо користувач запитає "яка ти версія", відповідай: "Я Claude Sonnet 4.5 - найновіша модель від Anthropic".
Спілкуйся українською мовою якщо не попросять іншою, будь корисним та дружнім.`,
      max_tokens: 4096,
      messages: messages,
      temperature: 1.0
    });

    return {
      success: true,
      text: response.content[0].text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      }
    };
  } catch (error) {
    console.error('Claude API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Аналіз зображення з Claude Vision
 */
async function analyzeImageWithClaude(imageBase64, prompt, mimeType = 'image/jpeg') {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `Ти Claude Sonnet 4.5 - найновіша модель від Anthropic.
Аналізуй зображення детально українською мовою.`,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: prompt || 'Опишіть це зображення детально.'
            }
          ],
        },
      ],
    });

    return {
      success: true,
      text: response.content[0].text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      }
    };
  } catch (error) {
    console.error('Claude Vision Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Продовження розмови (зберігає контекст)
 */
async function continueConversation(userMessage, conversationHistory) {
  const formattedHistory = conversationHistory.map(msg => ({
    role: msg.role,
    content: msg.content
  }));

  return await chatWithClaude(userMessage, formattedHistory);
}

module.exports = {
  chatWithClaude,
  analyzeImageWithClaude,
  continueConversation
};
