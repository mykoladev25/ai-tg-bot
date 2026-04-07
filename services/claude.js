const { GoogleGenAI, createPartFromBase64, createPartFromText } = require('@google/genai');
const {
  getAssistantLanguageInstruction,
  pickLocalizedText
} = require('../utils/i18n');

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const DEFAULT_GEMINI_ASSISTANT_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash'
];

function getClient() {
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

function parseAssistantModelList() {
  const raw = process.env.GOOGLE_GEMINI_ASSISTANT_MODELS || '';
  const envModels = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return (envModels.length ? envModels : DEFAULT_GEMINI_ASSISTANT_MODELS)
    .filter((model, index, list) => list.indexOf(model) === index);
}

function formatModelLabel(modelCode) {
  if (!modelCode) return 'Gemini';

  const [baseCode, maybePreview] = String(modelCode).split('-preview');
  const parts = baseCode
    .split('-')
    .slice(1)
    .map((part) => {
      if (part === 'pro') return 'Pro';
      if (part === 'flash') return 'Flash';
      return part;
    });

  let label = `Gemini ${parts.join(' ')}`.trim();
  if (maybePreview !== undefined || modelCode.endsWith('-preview')) {
    label += ' Preview';
  }

  return label;
}

function buildTextSystemPrompt(modelCode, localeSource = 'en') {
  const modelLabel = formatModelLabel(modelCode);
  return [
    `You are ${modelLabel} via the Google Gemini API.`,
    `If the user asks which version you are, answer: "I am ${modelLabel} via Google Gemini."`,
    getAssistantLanguageInstruction(localeSource),
    'Be helpful and concise.'
  ].join(' ');
}

function buildVisionSystemPrompt(modelCode, localeSource = 'en') {
  const modelLabel = formatModelLabel(modelCode);
  return [
    `You are ${modelLabel} via the Google Gemini API.`,
    'Analyze images carefully and answer clearly.',
    getAssistantLanguageInstruction(localeSource)
  ].join(' ');
}

function formatConversationHistory(conversationHistory = []) {
  return conversationHistory
    .filter((message) => message?.role && message?.content)
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [createPartFromText(String(message.content))]
    }));
}

function buildUsage(response) {
  return {
    input_tokens: response?.usageMetadata?.promptTokenCount || 0,
    output_tokens: response?.usageMetadata?.candidatesTokenCount || 0
  };
}

function parseGeminiError(error) {
  const rawMessage = error?.message || '';

  if (typeof rawMessage === 'string') {
    try {
      return JSON.parse(rawMessage);
    } catch (_) {
      // Fall through to response data.
    }
  }

  return error?.response?.data || null;
}

function getGeminiErrorContext(error) {
  const payload = parseGeminiError(error);
  const status = error?.status || payload?.error?.code || error?.response?.status || null;
  const providerMessage = payload?.error?.message || error?.message || '';

  return {
    payload,
    status,
    providerMessage
  };
}

function formatRetryDelay(seconds) {
  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return null;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${Math.max(1, Math.floor(totalSeconds))}s`;
}

function shouldTryNextGeminiModel(error) {
  const { status, providerMessage } = getGeminiErrorContext(error);

  if (status === 429) return true;
  if (status >= 500) return true;

  return (
    /RESOURCE_EXHAUSTED/i.test(providerMessage)
    || /quota exceeded/i.test(providerMessage)
    || /rate limit/i.test(providerMessage)
    || /temporarily unavailable/i.test(providerMessage)
    || /backend error/i.test(providerMessage)
    || /internal error/i.test(providerMessage)
    || /deadline|timed out|timeout/i.test(providerMessage)
    || /not found/i.test(providerMessage)
    || /not available/i.test(providerMessage)
  );
}

function getSafeGeminiErrorMessage(error, localeSource = 'en') {
  const { payload, status, providerMessage } = getGeminiErrorContext(error);
  const retryDelayRaw = payload?.error?.details
    ?.find((detail) => detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')
    ?.retryDelay;
  const retryDelay = retryDelayRaw ? formatRetryDelay(parseInt(retryDelayRaw, 10)) : null;

  if (
    status === 429
    || /RESOURCE_EXHAUSTED/i.test(providerMessage)
    || /quota exceeded/i.test(providerMessage)
    || /rate limit/i.test(providerMessage)
  ) {
    return retryDelay
      ? pickLocalizedText(localeSource, {
        uk: `Gemini тимчасово недоступний через ліміти провайдера. Спробуйте приблизно через ${retryDelay}.`,
        en: `Gemini is temporarily unavailable due to provider quota limits. Please try again in about ${retryDelay}.`
      })
      : pickLocalizedText(localeSource, {
        uk: 'Gemini тимчасово недоступний через ліміти провайдера. Спробуйте пізніше.',
        en: 'Gemini is temporarily unavailable due to provider quota limits. Please try again later.'
      });
  }

  if (status === 401 || status === 403) {
    return pickLocalizedText(localeSource, {
      uk: 'Доступ до Gemini API зараз недоступний. Зверніться до підтримки.',
      en: 'Gemini API access is not available right now. Please contact support.'
    });
  }

  if (status >= 500) {
    return pickLocalizedText(localeSource, {
      uk: 'Gemini тимчасово недоступний. Спробуйте пізніше.',
      en: 'Gemini is temporarily unavailable. Please try again later.'
    });
  }

  if (/deadline|timed out|timeout/i.test(providerMessage)) {
    return pickLocalizedText(localeSource, {
      uk: 'Gemini не встиг відповісти. Спробуйте ще раз.',
      en: 'Gemini did not respond in time. Please try again.'
    });
  }

  return pickLocalizedText(localeSource, {
    uk: 'Запит до Gemini не вдався. Спробуйте пізніше.',
    en: 'Gemini request failed. Please try again later.'
  });
}

async function generateWithFallback(buildRequest, options = {}) {
  if (!GEMINI_API_KEY) {
    return {
      success: false,
      error: pickLocalizedText(options.localeSource, {
        uk: 'Google Gemini API key не налаштовано',
        en: 'Google Gemini API key not configured'
      })
    };
  }

  const ai = getClient();
  const models = options.models || parseAssistantModelList();
  let lastError = null;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];

    try {
      const response = await ai.models.generateContent(buildRequest(model));
      if (!response?.text) {
        return {
          success: false,
          error: pickLocalizedText(options.localeSource, {
            uk: `${formatModelLabel(model)} не повернув текстову відповідь.`,
            en: `${formatModelLabel(model)} did not return a text response.`
          }),
          model,
          modelLabel: formatModelLabel(model)
        };
      }

      if (index > 0) {
        console.log(`Gemini assistant fallback succeeded: ${formatModelLabel(model)}`);
      }

      return {
        success: true,
        text: response.text,
        usage: buildUsage(response),
        model,
        modelLabel: formatModelLabel(model),
        fallbackUsed: index > 0
      };
    } catch (error) {
      lastError = error;
      const logPayload = {
        model,
        status: getGeminiErrorContext(error).status,
        message: error?.message,
        parsed: parseGeminiError(error)
      };

      if (index < models.length - 1 && shouldTryNextGeminiModel(error)) {
        console.warn('Gemini assistant fallback triggered:', logPayload);
        continue;
      }

      console.error('Gemini assistant API error:', logPayload);
      break;
    }
  }

  return {
    success: false,
    error: getSafeGeminiErrorMessage(lastError, options.localeSource),
    model: null,
    modelLabel: null
  };
}

async function chatWithClaude(message, conversationHistory = [], localeSource = 'en') {
  return generateWithFallback((model) => ({
    model,
    contents: [
      ...formatConversationHistory(conversationHistory),
      {
        role: 'user',
        parts: [createPartFromText(message)]
      }
    ],
    config: {
      systemInstruction: buildTextSystemPrompt(model, localeSource),
      temperature: 0.7,
      maxOutputTokens: 4096
    }
  }), { localeSource });
}

async function analyzeImageWithClaude(imageBase64, prompt, mimeType = 'image/jpeg', localeSource = 'en') {
  return generateWithFallback((model) => ({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          createPartFromBase64(imageBase64, mimeType),
          createPartFromText(
            prompt
            || pickLocalizedText(localeSource, {
              uk: 'Опиши це зображення детально.',
              en: 'Describe this image in detail.'
            })
          )
        ]
      }
    ],
    config: {
      systemInstruction: buildVisionSystemPrompt(model, localeSource),
      temperature: 0.4,
      maxOutputTokens: 4096
    }
  }), { localeSource });
}

async function continueConversation(userMessage, conversationHistory, localeSource = 'en') {
  return chatWithClaude(userMessage, conversationHistory, localeSource);
}

module.exports = {
  chatWithClaude,
  analyzeImageWithClaude,
  continueConversation,
  GEMINI_ASSISTANT_MODEL: DEFAULT_GEMINI_ASSISTANT_MODELS[0],
  GEMINI_ASSISTANT_MODELS: DEFAULT_GEMINI_ASSISTANT_MODELS,
  parseAssistantModelList
};
