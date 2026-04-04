/**
 * Gemini Image Service — генерація зображень через Google Gemini REST API.
 *
 * Підтримувані моделі:
 * - gemini-2.5-flash-image (Nano Banana)
 * - gemini-3-pro-image-preview (Nano Banana Pro)
 * - gemini-3.1-flash-image-preview (Nano Banana 2)
 */
{"duration":"5","mode":"pro","multi_prompt":[],"sound":false,"image_urls":["https://api.telegram.org/file/bot8372899303:AAFLK-b2GwIbvNdoFRY0p_3dEXjOaQUg2Mo/photos/file_896.jpg"],"multi_shots":false,"prompt":"ultra realistic cinematic macro video in a luxury bathroom\n\nREFERENCE:\nuse exact same red intimate device from reference images\nstrict geometry, identical shape, identical proportions, no redesign\n\nSCENE:\nclose-up shot, feminine hands holding the device horizontally above a sink\nluxury bathroom background, softly blurred (marble, warm tones)\n\nACTION TIMELINE:\n\n[0–2 sec]\na transparent gel lubricant slowly pours from a minimal luxury tube onto the top curved part of the device\ngel flows naturally, thick, glossy, forming smooth layers and droplets\nrealistic liquid physics, catching soft highlights\n\n[2–4 sec]\ngel continues to spread across the surface\nsmall droplets slide down naturally\ndevice remains still\n\n[4–6 sec]\ndevice begins a subtle vibration\nvery soft, controlled micro-movements (not shaking wildly)\ngentle pulsing motion, premium feel\n\n[6–8 sec]\nvibration continues slightly\ngel reacts subtly to motion (tiny shifts, realistic behavior)\n\nOBJECT DETAILS:\nmatte red silicone texture, ultra detailed\ngold metallic insert with realistic reflections and micro-scratches\n\nHANDS:\nnatural feminine hands, аккуратные пальцы, короткие ногти\n\nFOCUS:\nsharp focus on device and gel\nbackground blurred\n\nLIGHTING:\nsoft diffused daylight, premium commercial lighting\nrealistic reflections on gel and gold surface\n\nCAMERA:\nmacro shot, 85mm lens look\nshallow depth of field\nslight handheld micro-movement or very slow push-in\n\nSTYLE:\nultra realistic, high-end commercial, luxury product video\n\nIMPORTANT:\nno deformation of object during vibration\nno cartoon motion\nkeep vibration subtle and elegant\n\nNEGATIVE:\nwrong shape, distortion, aggressive shaking, plastic gel, CGI artifacts, extra fingers"}
const axios = require('axios');

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const FREE_GENERATIONS_LIMIT = 3;

// gemini-2.5-flash-image
const GEMINI_NANO_BANANA_MODEL = 'gemini-2.5-flash-image';
// gemini-3-pro-image-preview
const GEMINI_MODEL = 'gemini-3-pro-image-preview';
// gemini-3.1-flash-image-preview
const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

const MAX_REFERENCE_IMAGES = 14;
const MAX_RETRIES = 2; // 2 retries (504 = DEADLINE_EXCEEDED, retry часто допомагає)
const RETRY_DELAY_MS = 5000; // 5 секунд між retry
const REQUEST_TIMEOUT_MS = 180000; // 180с для text-only (Google рекомендує більший timeout для 504)
const REQUEST_TIMEOUT_WITH_IMAGES_MS = 240000; // 240с якщо є reference-зображення

const BASE_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const MODEL_CAPABILITIES = {
  [GEMINI_NANO_BANANA_MODEL]: {
    aspectRatios: BASE_ASPECT_RATIOS,
    imageSizes: ['1K'],
    defaultSize: '1K',
    supportsImageSize: false
  },
  [GEMINI_MODEL]: {
    aspectRatios: BASE_ASPECT_RATIOS,
    imageSizes: ['1K', '2K', '4K'],
    defaultSize: '1K'
  },
  [GEMINI_FLASH_IMAGE_MODEL]: {
    aspectRatios: [...BASE_ASPECT_RATIOS, '1:4', '4:1', '1:8', '8:1'],
    imageSizes: ['0.5K', '1K', '2K', '4K'],
    defaultSize: '1K'
  }
};

function getGeminiApiUrl(modelCode) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${modelCode}:generateContent`;
}

function getModelCapabilities(modelCode) {
  return MODEL_CAPABILITIES[modelCode] || MODEL_CAPABILITIES[GEMINI_MODEL];
}

/**
 * Визначити MIME type зображення.
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
 * Генерація зображення через Gemini REST API.
 * @param {string} prompt — текстовий промпт
 * @param {string|string[]|null} imageInput — референс-зображення (URL або масив URL, до 14)
 * @param {string} aspectRatio — пропорції ('1:1', '16:9', '9:16', тощо)
 * @param {string} imageSize — розмір виводу ('0.5K', '1K', '2K', '4K')
 * @param {string} modelCode — Gemini model code
 * @returns {Promise<{success: boolean, imageBuffer?: Buffer, mimeType?: string, error?: string}>}
 */
async function generateImage(
  prompt,
  imageInput = null,
  aspectRatio = '1:1',
  imageSize = '1K',
  modelCode = GEMINI_MODEL
) {
  if (!GEMINI_API_KEY) {
    return { success: false, error: 'Google Gemini API key not configured' };
  }

  const modelCaps = getModelCapabilities(modelCode);

  try {
    // ====== Підготовка частин контенту ======
    const parts = [];

    // Додаємо референс-зображення якщо є (до 14 шт)
    if (imageInput) {
      const images = Array.isArray(imageInput) ? imageInput.slice(0, MAX_REFERENCE_IMAGES) : [imageInput];
      const downloadPromises = images.map(async (imgUrl) => {
        // Retry loop: 2 attempts with 3s delay
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (attempt > 0) {
              console.log(`🔄 Gemini: retry download #${attempt} for ...${imgUrl.substring(imgUrl.length - 30)}`);
              await new Promise((r) => setTimeout(r, 3000));
            }
            const resp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 45000 });
            const base64 = Buffer.from(resp.data).toString('base64');
            const mimeType = detectMimeType(resp.headers, imgUrl, resp.data);
            console.log(`🔍 Gemini: MIME=${mimeType}, size=${(resp.data.length / 1024).toFixed(1)}KB for ...${imgUrl.substring(imgUrl.length - 30)}`);
            return { inline_data: { mime_type: mimeType, data: base64 } };
          } catch (imgErr) {
            const errMsg = imgErr.message || '';
            console.warn(`⚠️ Gemini: Failed to download ref image (attempt ${attempt + 1}/2): ${errMsg.substring(0, 100)}`);
            // Retry on network errors
            if (
              attempt === 0 &&
              (errMsg.includes('fetch failed') ||
                errMsg.includes('ECONNABORTED') ||
                errMsg.includes('ETIMEDOUT') ||
                errMsg.includes('socket hang up') ||
                imgErr.code === 'ECONNRESET')
            ) {
              continue; // retry
            }
            return null;
          }
        }
        return null;
      });

      const downloadedImages = (await Promise.all(downloadPromises)).filter(Boolean);
      parts.push(...downloadedImages);
      console.log(`🖼️ Gemini Image: ${downloadedImages.length}/${images.length} reference images loaded`);
    }

    // Додаємо текстовий промпт
    parts.push({ text: prompt });

    // Маппінг aspect ratio / imageSize під модель
    const mappedAspectRatio = modelCaps.aspectRatios.includes(aspectRatio) ? aspectRatio : '1:1';
    const supportsImageSize = modelCaps.supportsImageSize !== false;
    const mappedSize = supportsImageSize && modelCaps.imageSizes.includes(imageSize)
      ? imageSize
      : modelCaps.defaultSize;

    const refCount = parts.length - 1;
    console.log(`🖼️ Gemini Image: model=${modelCode}, aspect=${mappedAspectRatio}, size=${mappedSize}, refs=${refCount}`);

    // ====== REST API payload ======
    const payload = {
      contents: [{
        role: 'user',
        parts
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    };

    payload.generationConfig.imageConfig = supportsImageSize
      ? {
          aspectRatio: mappedAspectRatio,
          imageSize: mappedSize
        }
      : {
          aspectRatio: mappedAspectRatio
        };

    console.log(`📤 Gemini REST: POST ${modelCode}, parts=${parts.length}, timeout=${REQUEST_TIMEOUT_MS / 1000}s`);
    console.log(`📤 Gemini payload: model=${modelCode}, parts=${parts.length}, modalities=[TEXT,IMAGE], aspect=${mappedAspectRatio}, size=${mappedSize}, role=user`);

    // Динамічний timeout: більший якщо є reference images
    const hasImages = refCount > 0;
    const effectiveTimeout = hasImages ? REQUEST_TIMEOUT_WITH_IMAGES_MS : REQUEST_TIMEOUT_MS;
    console.log(`⏱️ Gemini timeout: ${effectiveTimeout / 1000}s (${hasImages ? 'with images' : 'text-only'})`);

    // ====== Виклик REST API з retry ======
    let apiResponse;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`🔄 Gemini: retry #${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }

        const startTime = Date.now();

        apiResponse = await axios.post(
          `${getGeminiApiUrl(modelCode)}?key=${GEMINI_API_KEY}`,
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
        console.log(`🖼️ Gemini REST: ${status} in ${elapsed}s (attempt ${attempt}), candidates=${candidates}, finishReason=${firstFinish}`);
        break; // success
      } catch (err) {
        const status = err.response?.status;
        const errData = err.response?.data?.error?.message || err.message || '';
        console.error(`❌ Gemini attempt ${attempt}: HTTP ${status || 'N/A'} — ${errData}`);

        // НЕ ретраїмо помилки які не зміняться
        if (status === 400 || status === 401 || status === 403) {
          throw err;
        }
        // 429 (rate limit) — ретраїмо з довшою паузою
        if (status === 429) {
          await new Promise((r) => setTimeout(r, 10000));
          if (attempt === MAX_RETRIES) throw err;
          continue;
        }
        // 504/503 (Gateway Timeout / DEADLINE_EXCEEDED) — Google рекомендує retry з більшим timeout
        if (status === 504 || status === 503) {
          console.log(`⚠️ Gemini: ${status} DEADLINE_EXCEEDED — waiting 10s before retry...`);
          await new Promise((r) => setTimeout(r, 10000));
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
      console.error(`❌ Gemini Image: No parts. finishReason=${finishReason}, content=${JSON.stringify(data?.candidates?.[0]?.content)}`);
      console.error(`❌ Gemini Image: Full response: candidates=${data?.candidates?.length}, usageMetadata=${JSON.stringify(data?.usageMetadata)?.substring(0, 300)}`);
      if (data?.candidates?.[0]) {
        console.error(`❌ Gemini Image: candidate[0] keys: ${Object.keys(data.candidates[0]).join(',')}`);
      }

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

    console.log(`🖼️ Gemini Image: ${responseParts.length} parts received`);
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
          console.log(`✅ Gemini Image: Image ${(imageBuffer.length / 1024).toFixed(1)}KB, mime=${mime}`);
          return { success: true, imageBuffer, mimeType: mime };
        }
        console.warn(`⚠️ Gemini Image: inlineData exists but data is empty. Keys: ${Object.keys(inlineData).join(', ')}`);
      }
    }

    // Якщо є тільки текст
    for (const part of responseParts) {
      if (part.text && !part.thought) {
        console.warn(`⚠️ Gemini Image returned text: ${part.text.substring(0, 200)}`);
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
      return { success: false, error: 'Google Gemini API не відповів вчасно. Спробуйте простіший промпт або без зображень.' };
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
  GEMINI_NANO_BANANA_MODEL,
  GEMINI_MODEL,
  GEMINI_FLASH_IMAGE_MODEL,
  get isConfigured() {
    return !!GEMINI_API_KEY;
  }
};
