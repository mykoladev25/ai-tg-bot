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
const MAX_RETRIES = 2;          // до 2 retry на fetch failed
const RETRY_DELAY_MS = 3000;    // 3 секунди між retry

let ai = null;

function getClient() {
  if (!ai && GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return ai;
}

/**
 * Визначити MIME type зображення
 */
function detectMimeType(headers, url, data) {
  const ct = (headers['content-type'] || '').split(';')[0].trim();
  if (ct && ct.startsWith('image/') && ct !== 'application/octet-stream') return ct;

  const u = url.toLowerCase();
  if (u.includes('.png')) return 'image/png';
  if (u.includes('.webp')) return 'image/webp';
  if (u.includes('.gif')) return 'image/gif';
  if (u.includes('.jpg') || u.includes('.jpeg')) return 'image/jpeg';

  // Magic bytes
  const b = Buffer.from(data).slice(0, 4);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
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
          const mimeType = detectMimeType(response.headers, imgUrl, response.data);
          console.log(`🔍 Gemini: MIME=${mimeType} for ...${imgUrl.substring(imgUrl.length - 30)}`);
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

    // Маппінг aspect ratio
    const validAspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
    const mappedAspectRatio = validAspectRatios.includes(aspectRatio) ? aspectRatio : '1:1';

    // Валідація imageSize
    const validSizes = ['1K', '2K', '4K'];
    const mappedSize = validSizes.includes(imageSize) ? imageSize : '1K';

    const refCount = contents.length - 1;
    console.log(`🍌 Gemini FREE: ${GEMINI_MODEL}, aspect=${mappedAspectRatio}, size=${mappedSize}, refs=${refCount}`);

    // ====== Виклик API з retry на fetch failed ======
    let response;
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`🔄 Gemini: retry #${attempt}/${MAX_RETRIES}...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }

        const startTime = Date.now();
        response = await client.models.generateContent({
          model: GEMINI_MODEL,
          contents: contents,
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              aspectRatio: mappedAspectRatio,
              imageSize: mappedSize
            }
          }
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`🍌 Gemini FREE: Response in ${elapsed}s (attempt ${attempt})`);
        break; // success

      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        console.error(`❌ Gemini attempt ${attempt}: ${msg}`);

        // НЕ ретраїмо помилки які не зміняться
        if (msg.includes('SAFETY') || msg.includes('blocked') ||
            msg.includes('INVALID_ARGUMENT') || msg.includes('403') ||
            msg.includes('401') || msg.includes('RECITATION') ||
            msg.includes('quota') || msg.includes('429')) {
          throw err;
        }
        // fetch failed, ECONNREFUSED, timeout — ретраїмо
        if (attempt === MAX_RETRIES) throw err;
      }
    }

    // ====== Парсимо відповідь ======
    const finishReason = response?.candidates?.[0]?.finishReason;
    const hasParts = response?.candidates?.[0]?.content?.parts?.length > 0;

    if (!hasParts) {
      console.error(`❌ Gemini FREE: No parts. finishReason=${finishReason}, content=${JSON.stringify(response?.candidates?.[0]?.content)}`);

      // Обробка конкретних finishReason
      if (finishReason === 'NO_IMAGE') {
        return { success: false, error: 'Gemini не зміг згенерувати зображення за цим промптом. Спробуйте більш детальний опис англійською.' };
      }
      if (finishReason === 'IMAGE_SAFETY' || finishReason === 'SAFETY') {
        return { success: false, error: 'Зображення заблоковано системою безпеки. Спробуйте інший промпт.' };
      }
      if (finishReason === 'RECITATION') {
        return { success: false, error: 'Запит порушує авторські права. Спробуйте переформулювати.' };
      }
      if (finishReason === 'MAX_TOKENS') {
        return { success: false, error: 'Промпт занадто довгий. Скоротіть текст і спробуйте ще раз.' };
      }
      return { success: false, error: `Gemini не повернув зображення (${finishReason || 'unknown'}). Спробуйте інший промпт або спробуйте ще раз.` };
    }

    const parts = response.candidates[0].content.parts;
    console.log(`🍌 Gemini FREE: ${parts.length} parts`);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const type = p.thought ? 'thought' : p.text ? 'text' : p.inlineData ? 'inlineData' : 'unknown';
      const dataLen = p.inlineData?.data ? p.inlineData.data.length : 0;
      const hasSig = !!p.thoughtSignature;
      console.log(`  part[${i}]: type=${type}, thought=${!!p.thought}, hasSig=${hasSig}, mime=${p.inlineData?.mimeType || '-'}, dataLen=${dataLen}`);
    }

    for (const part of parts) {
      if (part.inlineData && !part.thought) {
        // SDK може зберігати дані як .data (base64 string) або як bytes
        const base64Data = part.inlineData.data;
        if (base64Data && base64Data.length > 0) {
          const imageBuffer = Buffer.from(base64Data, 'base64');
          console.log(`✅ Gemini FREE: Image ${(imageBuffer.length / 1024).toFixed(1)}KB`);
          return {
            success: true,
            imageBuffer,
            mimeType: part.inlineData.mimeType || 'image/png'
          };
        } else {
          console.warn(`⚠️ Gemini FREE: inlineData exists but data is empty/missing. Keys: ${Object.keys(part.inlineData).join(', ')}`);
        }
      }
    }

    // Якщо є тільки текст
    for (const part of parts) {
      if (part.text && !part.thought) {
        console.warn(`⚠️ Gemini FREE returned text: ${part.text.substring(0, 200)}`);
        return { success: false, error: `Gemini повернув текст замість зображення: ${part.text.substring(0, 100)}` };
      }
    }

    return { success: false, error: 'Gemini не повернув зображення. Спробуйте інший промпт.' };

  } catch (error) {
    const errMsg = error.message || JSON.stringify(error);
    console.error('❌ Gemini Image Error:', errMsg);

    if (errMsg.includes('SAFETY') || errMsg.includes('blocked')) {
      return { success: false, error: 'Зображення заблоковано системою безпеки. Спробуйте інший промпт.' };
    }
    if (errMsg.includes('MIME type') || errMsg.includes('INVALID_ARGUMENT')) {
      return { success: false, error: 'Помилка формату зображення. Спробуйте без референсу або надішліть фото як зображення.' };
    }
    if (errMsg.includes('quota') || errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
      return { success: false, error: 'Ліміт запитів до Gemini перевищено. Спробуйте через хвилину.' };
    }
    if (errMsg.includes('permission') || errMsg.includes('403') || errMsg.includes('401')) {
      return { success: false, error: 'Немає доступу до Gemini API. Зверніться до підтримки.' };
    }
    if (errMsg.includes('RECITATION') || errMsg.includes('Could not generate')) {
      return { success: false, error: 'Не вдалось згенерувати. Спробуйте переформулювати промпт.' };
    }
    if (errMsg.includes('fetch failed') || errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND')) {
      return { success: false, error: 'Не вдалось з\'єднатися з Google API. Спробуйте через 30 секунд.' };
    }

    return { success: false, error: 'Помилка генерації. Спробуйте ще раз або оберіть іншу модель.' };
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
