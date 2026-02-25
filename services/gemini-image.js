/**
 * Gemini Image Service — генерація зображень через Google Gemini REST API
 *
 * Безкоштовна модель "Nano Banana FREE" для кожного користувача (5 генерацій).
 * Використовує прямий REST API (не SDK) для надійного timeout та error handling.
 *
 * gemini-3-pro-image-preview (Nano Banana Pro):
 * - До 14 референс-зображень (5 people + 6 objects)
 * - 1K / 2K / 4K resolution
 * - Aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
 * - Thinking mode (auto)
 */

const axios = require('axios');

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const FREE_GENERATIONS_LIMIT = 5;

// Модель: gemini-3-pro-image-preview (Nano Banana Pro)
const GEMINI_MODEL = 'gemini-3-pro-image-preview';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_REFERENCE_IMAGES = 14;
const MAX_RETRIES = 2;           // 2 retries (504 = DEADLINE_EXCEEDED, retry часто допомагає)
const RETRY_DELAY_MS = 5000;     // 5 секунд між retry
const REQUEST_TIMEOUT_MS = 180000;       // 180с для text-only (Google рекомендує більший timeout для 504)
const REQUEST_TIMEOUT_WITH_IMAGES_MS = 240000; // 240с якщо є referenceзображення

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
 * Генерація зображення через Gemini REST API (gemini-3-pro-image-preview)
 * @param {string} prompt — текстовий промпт
 * @param {string|string[]|null} imageInput — референс-зображення (URL або масив URL, до 14)
 * @param {string} aspectRatio — пропорції ('1:1', '16:9', '9:16', тощо)
 * @param {string} imageSize — розмір виводу ('1K', '2K', '4K')
 * @returns {Promise<{success: boolean, imageBuffer?: Buffer, mimeType?: string, error?: string}>}
 */
async function generateImage(prompt, imageInput = null, aspectRatio = '1:1', imageSize = '1K') {
  if (!GEMINI_API_KEY) {
    return { success: false, error: 'Google Gemini API key not configured' };
  }

  try {
    // ====== Підготовка частин контенту ======
    const parts = [];

    // Додаємо референс-зображення якщо є (до 14 шт)
    if (imageInput) {
      const images = Array.isArray(imageInput) ? imageInput.slice(0, MAX_REFERENCE_IMAGES) : [imageInput];
      const downloadPromises = images.map(async (imgUrl) => {
        try {
          const resp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
          const base64 = Buffer.from(resp.data).toString('base64');
          const mimeType = detectMimeType(resp.headers, imgUrl, resp.data);
          console.log(`🔍 Gemini: MIME=${mimeType} for ...${imgUrl.substring(imgUrl.length - 30)}`);
          return { inline_data: { mime_type: mimeType, data: base64 } };
        } catch (imgErr) {
          console.warn(`⚠️ Gemini: Failed to download reference image: ${imgErr.message}`);
          return null;
        }
      });

      const downloadedImages = (await Promise.all(downloadPromises)).filter(Boolean);
      parts.push(...downloadedImages);
      console.log(`🍌 Gemini FREE: ${downloadedImages.length}/${images.length} reference images loaded`);
    }

    // Додаємо текстовий промпт
    parts.push({ text: prompt });

    // Маппінг aspect ratio
    const validAspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
    const mappedAspectRatio = validAspectRatios.includes(aspectRatio) ? aspectRatio : '1:1';

    // Валідація imageSize
    const validSizes = ['1K', '2K', '4K'];
    const mappedSize = validSizes.includes(imageSize) ? imageSize : '1K';

    const refCount = parts.length - 1;
    console.log(`🍌 Gemini FREE: ${GEMINI_MODEL}, aspect=${mappedAspectRatio}, size=${mappedSize}, refs=${refCount}`);

    // ====== REST API payload ======
    const payload = {
      contents: [{
        parts: parts
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: mappedAspectRatio,
          imageSize: mappedSize
        }
      }
    };

    console.log(`📤 Gemini REST: POST ${GEMINI_MODEL}, parts=${parts.length}, timeout=${REQUEST_TIMEOUT_MS / 1000}s`);

    // Динамічний timeout: більший якщо є reference images
    const hasImages = refCount > 0;
    const effectiveTimeout = hasImages ? REQUEST_TIMEOUT_WITH_IMAGES_MS : REQUEST_TIMEOUT_MS;
    console.log(`⏱️ Gemini timeout: ${effectiveTimeout / 1000}s (${hasImages ? 'with images' : 'text-only'})`);

    // ====== Виклик REST API з retry ======
    let apiResponse;
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`🔄 Gemini: retry #${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }

        const startTime = Date.now();

        apiResponse = await axios.post(
          `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
          payload,
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: effectiveTimeout,
            maxBodyLength: 100 * 1024 * 1024,
            maxContentLength: 100 * 1024 * 1024
          }
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const status = apiResponse.status;
        const candidates = apiResponse.data?.candidates?.length || 0;
        const firstFinish = apiResponse.data?.candidates?.[0]?.finishReason || 'N/A';
        console.log(`🍌 Gemini REST: ${status} in ${elapsed}s (attempt ${attempt}), candidates=${candidates}, finishReason=${firstFinish}`);
        break; // success

      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        const errData = err.response?.data?.error?.message || err.message || '';
        console.error(`❌ Gemini attempt ${attempt}: HTTP ${status || 'N/A'} — ${errData}`);

        // НЕ ретраїмо помилки які не зміняться
        if (status === 400 || status === 401 || status === 403) {
          throw err;
        }
        // 429 (rate limit) — ретраїмо з довшою паузою
        if (status === 429) {
          await new Promise(r => setTimeout(r, 10000));
          if (attempt === MAX_RETRIES) throw err;
          continue;
        }
        // 504/503 (Gateway Timeout / DEADLINE_EXCEEDED) — Google рекомендує retry з більшим timeout
        if (status === 504 || status === 503) {
          console.log(`⚠️ Gemini: ${status} DEADLINE_EXCEEDED — waiting 10s before retry...`);
          await new Promise(r => setTimeout(r, 10000));
          if (attempt === MAX_RETRIES) throw err;
          continue;
        }
        // Мережеві помилки — ретраїмо
        if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
          if (attempt === MAX_RETRIES) throw err;
          continue;
        }
        // Інші — не ретраїмо
        throw err;
      }
    }

    // ====== Парсимо відповідь ======
    const data = apiResponse.data;
    const finishReason = data?.candidates?.[0]?.finishReason;
    // REST API повертає snake_case (inline_data), але деякі поля можуть бути camelCase
    const responseParts = data?.candidates?.[0]?.content?.parts;
    const hasParts = Array.isArray(responseParts) && responseParts.length > 0;

    if (!hasParts) {
      console.error(`❌ Gemini FREE: No parts. finishReason=${finishReason}, content=${JSON.stringify(data?.candidates?.[0]?.content)}`);

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
      return { success: false, error: `Gemini не повернув зображення (${finishReason || 'unknown'}). Спробуйте інший промпт.` };
    }

    console.log(`🍌 Gemini FREE: ${responseParts.length} parts received`);
    for (let i = 0; i < responseParts.length; i++) {
      const p = responseParts[i];
      const inlineData = p.inlineData || p.inline_data;
      const type = p.thought ? 'thought' : p.text ? 'text' : inlineData ? 'image' : 'unknown';
      const dataLen = inlineData?.data ? inlineData.data.length : 0;
      const hasSig = !!(p.thoughtSignature || p.thought_signature);
      const mime = inlineData?.mimeType || inlineData?.mime_type || '-';
      console.log(`  part[${i}]: type=${type}, thought=${!!p.thought}, hasSig=${hasSig}, mime=${mime}, dataLen=${dataLen}`);
    }

    // Шукаємо зображення (не thought)
    for (const part of responseParts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && !part.thought) {
        const base64Data = inlineData.data;
        if (base64Data && base64Data.length > 0) {
          const imageBuffer = Buffer.from(base64Data, 'base64');
          const mime = inlineData.mimeType || inlineData.mime_type || 'image/png';
          console.log(`✅ Gemini FREE: Image ${(imageBuffer.length / 1024).toFixed(1)}KB, mime=${mime}`);
          return { success: true, imageBuffer, mimeType: mime };
        } else {
          console.warn(`⚠️ Gemini FREE: inlineData exists but data is empty. Keys: ${Object.keys(inlineData).join(', ')}`);
        }
      }
    }

    // Якщо є тільки текст
    for (const part of responseParts) {
      if (part.text && !part.thought) {
        console.warn(`⚠️ Gemini FREE returned text: ${part.text.substring(0, 200)}`);
        return { success: false, error: `Gemini повернув текст замість зображення: ${part.text.substring(0, 100)}` };
      }
    }

    return { success: false, error: 'Gemini не повернув зображення. Спробуйте інший промпт.' };

  } catch (error) {
    const status = error.response?.status;
    const apiMsg = error.response?.data?.error?.message || '';
    const errMsg = apiMsg || error.message || JSON.stringify(error);
    console.error(`❌ Gemini Image Error: HTTP ${status || 'N/A'} — ${errMsg}`);

    if (status === 504 || status === 503) {
      return { success: false, error: 'Google Gemini API перевантажений або промпт занадто складний. Поради:\n• Спростіть промпт\n• Зменшіть кількість референс-зображень\n• Спробуйте через 30 секунд' };
    }
    if (status === 429) {
      return { success: false, error: 'Ліміт запитів до Gemini перевищено. Спробуйте через хвилину.' };
    }
    if (status === 401 || status === 403) {
      return { success: false, error: 'Немає доступу до Gemini API. Зверніться до підтримки.' };
    }
    if (status === 400) {
      if (apiMsg.includes('MIME type') || apiMsg.includes('INVALID_ARGUMENT')) {
        return { success: false, error: 'Помилка формату зображення. Спробуйте без референсу або надішліть як JPG/PNG.' };
      }
      return { success: false, error: `Невірний запит: ${apiMsg.substring(0, 150)}` };
    }
    if (errMsg.includes('SAFETY') || errMsg.includes('blocked')) {
      return { success: false, error: 'Зображення заблоковано системою безпеки. Спробуйте інший промпт.' };
    }
    if (errMsg.includes('RECITATION')) {
      return { success: false, error: 'Запит порушує авторські права. Спробуйте переформулювати.' };
    }
    if (error.code === 'ECONNABORTED') {
      return { success: false, error: `Google Gemini API не відповів вчасно. Спробуйте простіший промпт або без зображень.` };
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return { success: false, error: 'Не вдалось з\'єднатися з Google API. Спробуйте через 30 секунд.' };
    }

    return { success: false, error: `Помилка генерації: ${errMsg.substring(0, 150)}` };
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
