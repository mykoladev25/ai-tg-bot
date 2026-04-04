const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});


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
      system: `You are Claude Sonnet 4.5, the latest Anthropic model (claude-sonnet-4-20250514).
If the user asks which version you are, answer: "I am Claude Sonnet 4.5, the latest Anthropic model."
Respond in English by default unless the user explicitly asks for another language. Be helpful and concise.`,
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


async function analyzeImageWithClaude(imageBase64, prompt, mimeType = 'image/jpeg') {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `You are Claude Sonnet 4.5, the latest Anthropic model.
Analyze the image in detailed English.`,
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
              text: prompt || 'Describe this image in detail.'
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
