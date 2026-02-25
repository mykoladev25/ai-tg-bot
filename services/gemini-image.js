/**
 * Gemini Image Service — генерація зображень через Google Gemini API (gemini-3-pro-image-preview)
 *
 * Безкоштовна модель "Nano Banana FREE" для кожного користувача (5 генерацій).
 * Використовує @google/genai SDK напряму (не через Replicate/KIE.AI).
 *
 * gemini-3-pro-image-preview (Nano Banana Pro):
 * - До 14 референс-зображень (5 people + 6 objects)
 * - 1K / 2K / 4K resolution
 * - Aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
 * - Thinking mode (auto)
 */

const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const FREE_GENERATIONS_LIMIT = 5;

// Модель: gemini-3-pro-image-preview (Nano Banana Pro)
const GEMINI_MODEL = 'gemini-3-pro-image-preview';
const MAX_REFERENCE_IMAGES = 14;

let ai = null;

function getClient() {
  if (!ai && GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return ai;
}

/**
 * Генерація зображення через Gemini 3 Pro Image Preview (Nano Banana Pro)
 * @param {string} prompt — текстовий промпт
 * @param {string|string[]|null} imageInput — референс-зображення (URL або масив URL, до 14)
 * @param {string} aspectRatio — пропорції ('1:1', '16:9', '9:16', тощо)
 * @param {string} imageSize — розмір виводу ('1K', '2K', '4K')
 * @returns {Promise<{success: boolean, imageBuffer?: Buffer, mimeType?: string, error?: string}>}
 */
async function generateImage(prompt, imageInput = null, aspectRatio = '1:1', imageSize = '1K') {
  const client = getClient();
  if (!client) {
    return { success: false, error: 'Google Gemini API key not configured' };
  }

  try {
    // Підготовка контенту
    const contents = [];

    // Додаємо референс-зображення якщо є (до 14 шт для gemini-3-pro-image-preview)
    if (imageInput) {
      const images = Array.isArray(imageInput) ? imageInput.slice(0, MAX_REFERENCE_IMAGES) : [imageInput];
      const downloadPromises = images.map(async (imgUrl) => {
        try {
          const response = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
          const base64 = Buffer.from(response.data).toString('base64');
          const mimeType = response.headers['content-type'] || 'image/jpeg';
          return { inlineData: { mimeType, data: base64 } };
        } catch (imgErr) {
          console.warn(`⚠️ Gemini: Failed to download reference image: ${imgErr.message}`);
          return null;
        }
      });

      const downloadedImages = (await Promise.all(downloadPromises)).filter(Boolean);
      contents.push(...downloadedImages);
      console.log(`🍌 Gemini FREE: ${downloadedImages.length}/${images.length} reference images loaded`);
    }

    // Додаємо текстовий промпт
    contents.push({ text: prompt });

    // Маппінг aspect ratio (Gemini 3 Pro підтримує всі ці)
    const validAspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
    const mappedAspectRatio = validAspectRatios.includes(aspectRatio) ? aspectRatio : '1:1';

    // Валідація imageSize
    const validSizes = ['1K', '2K', '4K'];
    const mappedSize = validSizes.includes(imageSize) ? imageSize : '1K';

    const refCount = contents.length - 1; // мінус текстовий prompt
    console.log(`🍌 Gemini FREE: Generating with ${GEMINI_MODEL}, aspect=${mappedAspectRatio}, size=${mappedSize}, refs=${refCount}`);

    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: contents,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: mappedAspectRatio,
          imageSize: mappedSize
        }
      }
    });

    // Парсимо відповідь — шукаємо inline image data
    if (!response?.candidates?.[0]?.content?.parts) {
      return { success: false, error: 'No response from Gemini API' };
    }

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData && part.inlineData.data) {
        const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        console.log(`✅ Gemini FREE: Image generated, size=${(imageBuffer.length / 1024).toFixed(1)}KB, model=${GEMINI_MODEL}`);
        return {
          success: true,
          imageBuffer,
          mimeType: part.inlineData.mimeType || 'image/png'
        };
      }
    }

    // Якщо немає зображення, можливо є текст (safety block, thinking тощо)
    for (const part of response.candidates[0].content.parts) {
      if (part.text && !part.thought) {
        console.warn(`⚠️ Gemini FREE returned text instead of image: ${part.text.substring(0, 200)}`);
        return { success: false, error: `Gemini returned text: ${part.text.substring(0, 100)}` };
      }
    }

    return { success: false, error: 'No image in Gemini response' };

  } catch (error) {
    console.error('❌ Gemini Image Error:', error.message);

    // Обробка специфічних помилок
    if (error.message?.includes('SAFETY') || error.message?.includes('blocked')) {
      return { success: false, error: 'Зображення заблоковано системою безпеки. Спробуйте інший промпт.' };
    }
    if (error.message?.includes('quota') || error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED')) {
      return { success: false, error: 'Ліміт запитів до Gemini перевищено. Спробуйте через хвилину.' };
    }
    if (error.message?.includes('permission') || error.message?.includes('403')) {
      return { success: false, error: 'Немає доступу до Gemini API. Перевірте API ключ.' };
    }

    return { success: false, error: error.message };
  }
}

module.exports = {
  generateImage,
  FREE_GENERATIONS_LIMIT,
  MAX_REFERENCE_IMAGES,
  GEMINI_MODEL,
  get isConfigured() {
    return !!GEMINI_API_KEY;
  }
};
