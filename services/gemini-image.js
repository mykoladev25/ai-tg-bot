/**
 * Gemini Image service powered by the Google Gemini REST API.
 *
 * Supported models:
 * - gemini-2.5-flash-image (Nano Banana)
 * - gemini-3-pro-image-preview (Nano Banana Pro)
 * - gemini-3.1-flash-image-preview (Nano Banana 2)
 */
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
const MAX_RETRIES = 2; 
const RETRY_DELAY_MS = 5000; 
const REQUEST_TIMEOUT_MS = 180000; 
const REQUEST_TIMEOUT_WITH_IMAGES_MS = 240000; 

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
    const parts = [];

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

    parts.push({ text: prompt });

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

    const hasImages = refCount > 0;
    const effectiveTimeout = hasImages ? REQUEST_TIMEOUT_WITH_IMAGES_MS : REQUEST_TIMEOUT_MS;
    console.log(`⏱️ Gemini timeout: ${effectiveTimeout / 1000}s (${hasImages ? 'with images' : 'text-only'})`);

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

        if (status === 400 || status === 401 || status === 403) {
          throw err;
        }
        if (status === 429) {
          await new Promise((r) => setTimeout(r, 10000));
          if (attempt === MAX_RETRIES) throw err;
          continue;
        }
        if (status === 504 || status === 503) {
          console.log(`⚠️ Gemini: ${status} DEADLINE_EXCEEDED — waiting 10s before retry...`);
          await new Promise((r) => setTimeout(r, 10000));
          if (attempt === MAX_RETRIES) throw err;
          continue;
        }
        if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
          if (attempt === MAX_RETRIES) throw err;
          continue;
        }
        throw err;
      }
    }

    const data = apiResponse.data;
    const finishReason = data?.candidates?.[0]?.finishReason;
    const responseParts = data?.candidates?.[0]?.content?.parts;
    const hasParts = Array.isArray(responseParts) && responseParts.length > 0;

    if (!hasParts) {
      console.error(`❌ Gemini Image: No parts. finishReason=${finishReason}, content=${JSON.stringify(data?.candidates?.[0]?.content)}`);
      console.error(`❌ Gemini Image: Full response: candidates=${data?.candidates?.length}, usageMetadata=${JSON.stringify(data?.usageMetadata)?.substring(0, 300)}`);
      if (data?.candidates?.[0]) {
        console.error(`❌ Gemini Image: candidate[0] keys: ${Object.keys(data.candidates[0]).join(',')}`);
      }

      if (finishReason === 'NO_IMAGE') {
        return { success: false, error: 'Gemini could not generate an image for this prompt. Try a more detailed English description.' };
      }
      if (finishReason === 'IMAGE_SAFETY' || finishReason === 'SAFETY') {
        return { success: false, error: 'The image was blocked by the safety system. Try a different prompt.' };
      }
      if (finishReason === 'RECITATION') {
        return { success: false, error: 'The request may violate copyright restrictions. Try rephrasing it.' };
      }
      if (finishReason === 'MAX_TOKENS') {
        return { success: false, error: 'The prompt is too long. Shorten it and try again.' };
      }
      return { success: false, error: `Gemini did not return an image (${finishReason || 'unknown'}). Try a different prompt.` };
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

    for (const part of responseParts) {
      if (part.text && !part.thought) {
        console.warn(`⚠️ Gemini Image returned text: ${part.text.substring(0, 200)}`);
        return { success: false, error: `Gemini returned text instead of an image: ${part.text.substring(0, 100)}` };
      }
    }

    return { success: false, error: 'Gemini did not return an image. Try a different prompt.' };
  } catch (error) {
    const status = error.response?.status;
    const apiMsg = error.response?.data?.error?.message || '';
    const errMsg = apiMsg || error.message || JSON.stringify(error);
    console.error(`❌ Gemini Image Error: HTTP ${status || 'N/A'} — ${errMsg}`);

    if (status === 504 || status === 503) {
      return { success: false, error: 'Google Gemini API is overloaded or the prompt is too complex. Try simplifying the prompt, reducing reference images, and retrying in 30 seconds.' };
    }
    if (status === 429) {
      return { success: false, error: 'The Gemini request limit was exceeded. Try again in a minute.' };
    }
    if (status === 401 || status === 403) {
      return { success: false, error: 'Gemini API access is not available. Contact support.' };
    }
    if (status === 400) {
      if (apiMsg.includes('MIME type') || apiMsg.includes('INVALID_ARGUMENT')) {
        return { success: false, error: 'Unsupported image format. Try without a reference or upload a JPG/PNG image.' };
      }
      return { success: false, error: `Invalid request: ${apiMsg.substring(0, 150)}` };
    }
    if (errMsg.includes('SAFETY') || errMsg.includes('blocked')) {
      return { success: false, error: 'The image was blocked by the safety system. Try a different prompt.' };
    }
    if (errMsg.includes('RECITATION')) {
      return { success: false, error: 'The request may violate copyright restrictions. Try rephrasing it.' };
    }
    if (error.code === 'ECONNABORTED') {
      return { success: false, error: 'Google Gemini API did not respond in time. Try a simpler prompt or remove image references.' };
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return { success: false, error: 'Could not connect to the Google API. Try again in 30 seconds.' };
    }

    return { success: false, error: `Generation error: ${errMsg.substring(0, 150)}` };
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
