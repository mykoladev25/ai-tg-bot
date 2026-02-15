/**
 * KIE.AI провайдер для генерацій через api.kie.ai
 * Документація: https://docs.kie.ai/market/google/pro-image-to-image
 *
 * Альтернатива до Replicate для адміністраторів
 */

const axios = require('axios');

const KIE_API_BASE = 'https://api.kie.ai/api/v1';
const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const accessControl = require('../config/access');

// ==================== HELPER FUNCTIONS ====================

/**
 * Перевіряємо чи користувач є адміном (з config/access, підтримка кількох адмінів)
 */
function isAdminUser(userId) {
  return accessControl.isAdmin(userId);
}

/**
 * Офіційний endpoint для отримання статусу таску (Get Task Details).
 * Документація: https://docs.kie.ai/market/common/get-task-detail
 * Статуси: waiting, queuing, generating, success, fail
 */
async function fetchTaskRecordInfo(taskId) {
  const response = await axios.get(
    `${KIE_API_BASE}/jobs/recordInfo`,
    {
      params: { taskId },
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data?.data || null;
}

/**
 * Polling для отримання результату від KIE.AI API (Market models: Nano Banana, Seedream, Ideogram, Recraft тощо).
 * Використовує офіційний GET /jobs/recordInfo?taskId= (не /jobs/status/).
 * Статуси за документацією: waiting, queuing, generating, success, fail
 */
async function pollJobStatus(taskId, maxAttempts = 400, interval = 3000, modelName = 'KIE.AI') {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const job = await fetchTaskRecordInfo(taskId);
      if (!job) {
        console.warn(`⚠️ ${modelName} recordInfo empty for ${taskId}`);
        await new Promise(resolve => setTimeout(resolve, interval));
        attempts++;
        continue;
      }

      const state = (job.state || job.status || '').toLowerCase();

      console.log(`📊 ${modelName} status (attempt ${attempts + 1}): ${state}`);

      if (state === 'success' || state === 'completed') {
        return job;
      }
      if (state === 'fail' || state === 'failed' || state === 'error') {
        const errorMsg = job.failMsg || job.failCode || job.error || 'Unknown error';
        throw new Error(`Task failed: ${errorMsg}`);
      }
      // waiting, queuing, generating (або running) — продовжуємо polling

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`⚠️ Task ${taskId} not found, retrying...`);
      } else if (error.message.includes('Task failed')) {
        throw error;
      } else {
        console.error(`⚠️ Polling error:`, error.message);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    }
  }

  // Остання спроба: затримка + ще один запит
  await new Promise(resolve => setTimeout(resolve, interval));
  try {
    const job = await fetchTaskRecordInfo(taskId);
    const state = (job?.state || job?.status || '').toLowerCase();
    if (state === 'success' || state === 'completed') {
      console.log(`📊 ${modelName} got result on final check`);
      return job;
    }
  } catch (e) {
    // ігноруємо
  }

  throw new Error(`Timeout waiting for ${modelName} task completion (${taskId})`);
}

/**
 * Нормалізувати зображення input
 */
function normalizeImageInput(imageInput, maxImages = 3) {
  if (!imageInput) return [];

  if (Array.isArray(imageInput)) {
    const validatedInput = imageInput.slice(0, maxImages);
    if (imageInput.length > maxImages) {
      console.warn(`Image count limited from ${imageInput.length} to ${maxImages}`);
    }
    return validatedInput;
  }

  return [imageInput];
}

/**
 * Витягти URL зображення з результату KIE.AI
 * Формат може бути різний залежно від моделі
 */
function extractImageUrl(result) {
  if (!result) return null;

  // Масив URL (напр. від KIE: ["https://..."])
  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'string') {
    return result[0];
  }
  if (Array.isArray(result.output) && result.output.length > 0 && typeof result.output[0] === 'string') {
    return result.output[0];
  }

  if (result.resultJson) {
    try {
      const parsed = JSON.parse(result.resultJson);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
        return parsed[0];
      }
      if (parsed.resultUrls && parsed.resultUrls.length > 0) {
        return parsed.resultUrls[0];
      }
    } catch (e) {
      console.warn('Failed to parse resultJson:', e.message);
    }
  }

  if (result.output?.image_url) {
    return result.output.image_url;
  }

  if (result.output?.resultUrls && result.output.resultUrls.length > 0) {
    return result.output.resultUrls[0];
  }

  if (result.result_url) {
    return result.result_url;
  }

  return null;
}

/**
 * Витягти URL відео з результату KIE.AI
 */
function extractVideoUrl(result) {
  if (result.resultJson) {
    try {
      const parsed = JSON.parse(result.resultJson);
      if (parsed.resultUrls && parsed.resultUrls.length > 0) {
        return parsed.resultUrls[0];
      }
    } catch (e) {
      console.warn('Failed to parse resultJson:', e.message);
    }
  }

  if (result.output?.video_url) {
    return result.output.video_url;
  }

  if (result.output?.resultUrls && result.output.resultUrls.length > 0) {
    return result.output.resultUrls[0];
  }

  if (result.result_url) {
    return result.result_url;
  }

  return null;
}

// ==================== IMAGE GENERATION ====================

/**
 * Генерація зображення через KIE.AI - Nano Banana Pro
 *
 * Документація: https://docs.kie.ai/market/google/nano-banana-pro
 *
 * Підтримує:
 * - text2img (без зображень) - image_input: []
 * - img2img (з референсами) - image_input: [url1, url2, ...]
 *
 * Параметри:
 * - prompt: текстовий опис (обов'язково)
 * - imageInput: URL або масив URL зображень (до 8, опційно)
 * - resolution: "1K", "2K" або "4K" (default: "2K")
 * - aspectRatio: "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"
 */
async function generateWithNanoBananaKieAI(prompt, imageInput = null, resolution = "2K", aspectRatio = "1:1") {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!prompt) {
      throw new Error('Prompt є обов\'язковим для Nano Banana Pro');
    }

    // Нормалізуємо зображення (до 8 штук, або пустий масив для text2img)
    const images = imageInput ? normalizeImageInput(imageInput, 8) : [];
    const isText2Img = images.length === 0;

    console.log(`🎨 KIE.AI Nano Banana Pro (${isText2Img ? 'text2img' : 'img2img'}):`, {
      prompt: prompt.substring(0, 100),
      resolution,
      aspectRatio,
      imageCount: images.length
    });

    // ✅ Структура за документацією KIE.AI
    // https://docs.kie.ai/market/google/nano-banana-pro
    const payload = {
      model: 'nano-banana-pro',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: {
        prompt: prompt,
        image_input: images,  // масив URL або [] для text2img
        aspect_ratio: aspectRatio || '1:1',
        resolution: resolution,  // "1K", "2K", "4K"
        output_format: 'png'
      }
    };

    console.log(`📤 KIE.AI Nano Banana request:`, {
      model: payload.model,
      mode: isText2Img ? 'text2img' : 'img2img',
      images: images.length,
      resolution,
      aspectRatio
    });

    // Логуємо актуальну ціну KIE.AI
    try {
      const kiePricingSync = require('./kie-pricing-sync');
      let modelKey;
      if (resolution === '4K') {
        modelKey = 'nano_banana_4k';
      } else if (resolution === '2K') {
        modelKey = 'nano_banana_2k';
      } else {
        modelKey = 'nano_banana';  // 1K - базовий
      }
      const kiePrice = kiePricingSync.getModelPriceSync(modelKey);
      if (kiePrice) {
        console.log(`💰 KIE.AI price: $${kiePrice} (${resolution})`);
      }
    } catch (err) {
      // Не критично
    }

    // Створюємо таск на KIE.AI
    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Nano Banana response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    // Очікуємо на результат (polling): до ~50 хв (KIE асинхронна; іноді статус довго "running")
    const result = await pollJobStatus(taskId, 600, 5000, 'Nano Banana Pro (KIE.AI)');

    // Отримуємо URL зображення з результату
    const imageUrl = extractImageUrl(result);
    if (!imageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Nano Banana Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

/**
 * Генерація через KIE.AI - Seedream 4.5
 *
 * Документація: https://docs.kie.ai/market/bytedance/seedream-4.5
 *
 * ДВІ МОДЕЛІ:
 * - seedream/4.5-text-to-image - для text2img (без зображень)
 * - seedream/4.5-edit - для img2img (з image_urls)
 *
 * Параметри:
 * - prompt: текстовий опис (обов'язково)
 * - imageInput: URL або масив URL зображень (опційно, якщо є - використовуємо edit)
 * - aspectRatio: "1:1", "16:9", "9:16", etc
 * - quality: "basic" або "hd"
 */
async function generateWithSeedreamKieAI(prompt, imageInput = null, aspectRatio = "1:1", quality = "basic") {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!prompt) {
      throw new Error('Prompt є обов\'язковим для Seedream');
    }

    // Нормалізуємо зображення
    const images = imageInput ? normalizeImageInput(imageInput, 14) : [];
    const isEdit = images.length > 0;

    // Вибираємо модель залежно від наявності зображень
    const modelName = isEdit ? 'seedream/4.5-edit' : 'seedream/4.5-text-to-image';

    console.log(`🎨 KIE.AI Seedream (${isEdit ? 'edit/img2img' : 'text2img'}):`, {
      prompt: prompt.substring(0, 100),
      aspectRatio,
      quality,
      imageCount: images.length
    });

    // ✅ Структура за документацією KIE.AI
    const input = {
      prompt: prompt,
      aspect_ratio: aspectRatio || '1:1',
      quality: quality  // "basic" або "hd"
    };

    // Для edit моделі додаємо image_urls
    if (isEdit) {
      input.image_urls = images;
    }

    const payload = {
      model: modelName,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Seedream request:`, {
      model: payload.model,
      mode: isEdit ? 'edit' : 'text2img',
      images: images.length
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Seedream response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 400, 3000, 'Seedream (KIE.AI)');

    // Отримуємо URL зображення
    const imageUrl = extractImageUrl(result);
    if (!imageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Seedream Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

/**
 * ❌ Stable Diffusion НЕ підтримується на KIE.AI
 * Використовуйте Replicate для цієї моделі
 */
async function generateWithStableDiffusionKieAI(prompt, imageInput = null, aspectRatio = "1:1") {
  return {
    success: false,
    error: 'Stable Diffusion не підтримується на KIE.AI. Використовуйте Replicate.',
    provider: 'kie-ai',
    notSupported: true
  };
}

/**
 * Генерація через KIE.AI - Recraft Crisp Upscale
 *
 * Документація: https://docs.kie.ai/market/recraft/crisp-upscale
 *
 * Параметри:
 * - imageUrl: URL зображення для апскейлу (обов'язково)
 */
async function generateWithRecraftUpscaleKieAI(imageUrl) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!imageUrl) {
      throw new Error('Recraft Upscale вимагає зображення');
    }

    console.log(`✨ KIE.AI Recraft Crisp Upscale`);

    // ✅ Структура за документацією KIE.AI
    const payload = {
      model: 'recraft/crisp-upscale',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: {
        image: imageUrl
      }
    };

    console.log(`📤 KIE.AI Recraft Upscale request`);

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Recraft response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 400, 3000, 'Recraft Upscale (KIE.AI)');

    const resultImageUrl = extractImageUrl(result);
    if (!resultImageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: resultImageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Recraft Upscale Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

/**
 * Генерація через KIE.AI - Ideogram v3
 *
 * Документація: https://docs.kie.ai/market/ideogram/v3
 *
 * Моделі:
 * - ideogram/v3-reframe - для reframe (зміна розміру/співвідношення)
 * - ideogram/v3-remix - для remix (редагування)
 * - ideogram/v3-edit - для edit (редагування з маскою)
 *
 * Параметри:
 * - imageUrl: URL зображення (обов'язково)
 * - imageSize: 'square_hd', 'landscape_hd', 'portrait_hd', etc
 * - renderingSpeed: 'TURBO', 'BALANCED', 'QUALITY'
 * - style: 'AUTO', 'REALISTIC', 'DESIGN', etc
 * - numImages: '1' - '4'
 */
async function generateWithIdeogramKieAI(imageUrl, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!imageUrl) {
      throw new Error('Ideogram вимагає зображення');
    }

    const {
      mode = 'reframe',         // 'reframe', 'remix', 'edit'
      imageSize = 'square_hd',  // 'square_hd', 'landscape_hd', 'portrait_hd'
      renderingSpeed = 'BALANCED',  // 'TURBO', 'BALANCED', 'QUALITY'
      style = 'AUTO',           // 'AUTO', 'REALISTIC', 'DESIGN', etc
      numImages = '1',          // '1' - '4'
      seed = 0,
      prompt = ''               // для remix/edit
    } = options;

    // Вибираємо модель
    const modelName = `ideogram/v3-${mode}`;

    console.log(`🎨 KIE.AI Ideogram v3 (${mode}):`, {
      imageSize,
      renderingSpeed,
      style,
      numImages
    });

    // ✅ Структура за документацією KIE.AI
    const input = {
      image_url: imageUrl,
      image_size: imageSize,
      rendering_speed: renderingSpeed,
      style: style,
      num_images: numImages,
      seed: seed
    };

    // Для remix/edit можна додати prompt
    if (prompt && (mode === 'remix' || mode === 'edit')) {
      input.prompt = prompt;
    }

    const payload = {
      model: modelName,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Ideogram request:`, {
      model: payload.model,
      imageSize,
      renderingSpeed
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Ideogram response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 400, 3000, 'Ideogram (KIE.AI)');

    // Отримуємо URL зображення
    const resultImageUrl = extractImageUrl(result);
    if (!resultImageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: resultImageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Ideogram Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

// ==================== VIDEO GENERATION ====================

/**
 * Генерація через KIE.AI - Kling Motion Control
 *
 * Документація: https://docs.kie.ai/market/kling/motion-control
 *
 * Параметри:
 * - prompt: текстовий опис руху
 * - imageUrl: URL зображення персонажа
 * - videoUrl: URL відео з референсними рухами
 * - mode: '720p' або '1080p'
 * - characterOrientation: 'image' (до 10s) або 'video' (до 30s)
 */
async function generateKlingMotionKieAI(prompt, imageUrl, videoUrl, mode = '720p', characterOrientation = 'image') {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!imageUrl || !videoUrl) {
      throw new Error('KIE.AI Kling Motion вимагає і зображення і відео');
    }

    console.log(`🎥 KIE.AI Kling Motion Control:`, {
      prompt: prompt?.substring(0, 100) || 'no prompt',
      mode,
      characterOrientation
    });

    // ✅ Структура за документацією KIE.AI
    // https://docs.kie.ai/market/kling/motion-control
    const payload = {
      model: 'kling-2.6/motion-control',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: {
        prompt: prompt || '',
        input_urls: [imageUrl],  // зображення персонажа
        video_urls: [videoUrl],  // відео з рухами
        mode: mode,  // '720p' або '1080p'
        character_orientation: characterOrientation  // 'image' або 'video'
      }
    };

    console.log(`📤 KIE.AI Kling Motion request:`, {
      model: payload.model,
      mode,
      orientation: characterOrientation
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Kling Motion response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    // Kling Motion може займати довше часу
    // Відео: до ~50 хв (Kling Motion може генерувати довго)
    const result = await pollJobStatus(taskId, 600, 5000, 'Kling Motion (KIE.AI)');

    // Отримуємо URL відео
    const videoResultUrl = extractVideoUrl(result);
    if (!videoResultUrl) {
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoResultUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Kling Motion Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

/**
 * Генерація через KIE.AI - Kling 3.0
 *
 * Документація: https://docs.kie.ai/market/kling/kling-3.0
 *
 * 🆕 Нові можливості Kling 3.0:
 * - Multi-shot mode: кілька сцен в одному відео
 * - Element references: використання @element_name в промпті
 * - Тривалість 3-15 секунд
 * - Режими std (стандарт) та pro (висока якість)
 *
 * Режими:
 * - Single-shot (multi_shots: false): звичайна генерація
 * - Multi-shot (multi_shots: true): кілька сцен з різними промптами
 *
 * Element References:
 * - Використовуйте @element_name в промпті
 * - Визначте елементи в kling_elements масиві
 * - Image elements: 2-4 зображення (JPG/PNG, max 10MB)
 * - Video elements: 1 відео (MP4/MOV, max 50MB)
 *
 * Параметри:
 * - prompt: текстовий опис (для single-shot)
 * - imageUrls: масив URL зображень [first_frame, last_frame] (опційно)
 * - sound: true/false (звукові ефекти)
 * - duration: '3'-'15' (string!)
 * - aspectRatio: '16:9', '9:16', '1:1'
 * - mode: 'std' або 'pro'
 * - multiShots: true/false
 * - multiPrompt: масив {prompt, duration} для multi-shot
 * - klingElements: масив елементів для @references
 */
async function generateKling3VideoKieAI(options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    const {
      prompt = '',              // Промпт для single-shot
      imageUrls = [],           // [first_frame, last_frame] або [first_frame]
      sound = true,             // Звукові ефекти
      duration = '5',           // '3'-'15'
      aspectRatio = '16:9',     // '16:9', '9:16', '1:1'
      mode = 'pro',             // 'std' або 'pro'
      multiShots = false,       // Multi-shot mode
      multiPrompt = [],         // [{prompt, duration}, ...] для multi-shot
      klingElements = []        // Element references
    } = options;

    // Валідація
    if (!multiShots && !prompt) {
      throw new Error('Prompt є обов\'язковим для single-shot режиму');
    }

    if (multiShots && (!multiPrompt || multiPrompt.length === 0)) {
      throw new Error('multiPrompt є обов\'язковим для multi-shot режиму');
    }

    console.log(`🎥 KIE.AI Kling 3.0 (${multiShots ? 'multi-shot' : 'single-shot'}):`, {
      prompt: prompt?.substring(0, 100) || 'multi-shot mode',
      duration,
      aspectRatio,
      mode,
      sound,
      multiShots,
      shots: multiPrompt?.length || 0,
      elements: klingElements?.length || 0,
      hasImages: imageUrls?.length || 0
    });

    // ✅ Структура за документацією KIE.AI (sound — рядок 'on'|'off'; при multi_shots обов'язково 'on')
    const input = {
      sound: multiShots ? 'on' : (sound ? 'on' : 'off'),
      duration: String(duration),
      mode: mode,
      multi_shots: multiShots
    };

    // Aspect ratio (auto-adapt якщо є image_urls)
    if (!imageUrls || imageUrls.length === 0) {
      input.aspect_ratio = aspectRatio || '1:1';
    }

    // First/last frame images
    if (imageUrls && imageUrls.length > 0) {
      input.image_urls = imageUrls.slice(0, 2); // max 2 (first + last frame)
    }

    if (multiShots) {
      // Multi-shot mode
      input.multi_prompt = multiPrompt.map(shot => ({
        prompt: shot.prompt,
        duration: parseInt(shot.duration) || 3
      }));
      // Для multi-shot prompt не використовується
      input.prompt = '';
    } else {
      // Single-shot mode
      input.prompt = prompt;
      input.multi_prompt = []; // Пустий масив для single-shot
    }

    // Element references
    if (klingElements && klingElements.length > 0) {
      input.kling_elements = klingElements.map(el => {
        const element = {
          name: el.name,
          description: el.description || el.name
        };

        if (el.imageUrls && el.imageUrls.length > 0) {
          element.element_input_urls = el.imageUrls.slice(0, 4); // 2-4 images
        }

        if (el.videoUrl) {
          element.element_input_video_urls = [el.videoUrl]; // 1 video
        }

        return element;
      });
    }

    const payload = {
      model: 'kling-3.0/video',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Kling 3.0 request:`, {
      model: payload.model,
      mode: input.mode,
      multiShots: input.multi_shots,
      duration: input.duration,
      sound: input.sound
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = createResponse?.data?.data;
    const taskId = data?.taskId;
    if (!taskId) {
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';
      const errText = typeof apiMsg === 'string' ? apiMsg : (createResponse?.data ? JSON.stringify(createResponse.data) : 'KIE.AI не повернув taskId');
      console.error('❌ KIE.AI Kling 3.0 createTask: no taskId', createResponse?.data);
      return {
        success: false,
        error: errText || 'Сервер не повернув ідентифікатор завдання. Спробуйте ще раз.',
        provider: 'kie-ai'
      };
    }
    console.log(`✅ KIE.AI Kling 3.0 task created: ${taskId}`);

    // Kling 3.0 може займати довше (до 15 сек відео)
    // Відео: до ~50 хв
    const result = await pollJobStatus(taskId, 600, 5000, 'Kling 3.0 (KIE.AI)');

    const videoUrl = extractVideoUrl(result);
    if (!videoUrl) {
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      taskId: taskId,
      provider: 'kie-ai',
      mode: mode,
      multiShots: multiShots
    };

  } catch (error) {
    const res = error.response?.data;
    console.error('❌ KIE.AI Kling 3.0 Error:', res || error.message);
    const errMsg = (typeof res?.msg === 'string' ? res.msg : null) || res?.message || error.message;
    return {
      success: false,
      error: errMsg,
      provider: 'kie-ai'
    };
  }
}

/**
 * Генерація через KIE.AI - Kling v2.5 / v2.6
 *
 * Документація:
 * - v2.5: https://docs.kie.ai/market/kling/v2.5
 * - v2.6: https://docs.kie.ai/market/kling/v2.6
 *
 * Моделі v2.6:
 * - kling-2.6/text-to-video - для text2video (без зображень)
 * - kling-2.6/image-to-video - для image2video (з image_urls)
 *
 * Моделі v2.5:
 * - kling/v2-5-turbo-image-to-video-pro - для image2video з розширеними параметрами
 *
 * Параметри:
 * - prompt: текстовий опис (обов'язково)
 * - imageUrl: URL зображення (опційно)
 * - tailImageUrl: URL кінцевого кадру (тільки v2.5)
 * - duration: '5' або '10' (string!)
 * - aspectRatio: '1:1', '16:9', '9:16' (тільки для text-to-video)
 * - sound: true/false (генерація аудіо)
 * - version: 'v2.5' або 'v2.6' (default: 'v2.6')
 * - negativePrompt: що виключити (тільки v2.5)
 * - cfgScale: 0-1 (тільки v2.5)
 */
async function generateKlingVideoKieAI(prompt, imageUrl = null, duration = '5', aspectRatio = '16:9', sound = false, version = 'v2.6', options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!prompt) {
      throw new Error('Prompt є обов\'язковим для Kling');
    }

    const isImage2Video = !!imageUrl;
    const { tailImageUrl = '', negativePrompt = '', cfgScale = 0.5 } = options;

    // Вибираємо модель залежно від версії та типу
    let modelName;
    if (version === 'v2.5') {
      // v2.5 - тільки image-to-video з розширеними параметрами
      // ⚠️ ОБОВ'ЯЗКОВО потрібне початкове зображення!
      if (!imageUrl) {
        throw new Error('Kling v2.5 підтримує тільки image-to-video. Будь ласка, завантажте початкове зображення.');
      }
      modelName = 'kling/v2-5-turbo-image-to-video-pro';
    } else {
      // v2.6
      modelName = isImage2Video ? 'kling-2.6/image-to-video' : 'kling-2.6/text-to-video';
    }

    console.log(`🎥 KIE.AI Kling ${version} (${isImage2Video ? 'image2video' : 'text2video'}):`, {
      prompt: prompt.substring(0, 100),
      duration,
      aspectRatio,
      sound,
      hasImage: isImage2Video,
      hasTailImage: !!tailImageUrl
    });

    let input;

    if (version === 'v2.5') {
      // ✅ Структура v2.5 за документацією
      input = {
        prompt: prompt,
        image_url: imageUrl || '',
        tail_image_url: tailImageUrl,
        duration: String(duration),
        negative_prompt: negativePrompt,
        cfg_scale: cfgScale
      };
    } else {
      // ✅ Структура v2.6 за документацією
      input = {
        prompt: prompt,
        sound: sound,
        duration: String(duration)
      };

      if (!isImage2Video) {
        input.aspect_ratio = aspectRatio || '16:9';
      }

      if (isImage2Video) {
        input.image_urls = [imageUrl];
      }
    }

    const payload = {
      model: modelName,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Kling ${version} request:`, {
      model: payload.model,
      mode: isImage2Video ? 'image2video' : 'text2video',
      duration,
      sound,
      payload: JSON.stringify(payload, null, 2)
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    // Відео Kling v2.5/v2.6: до ~50 хв
    const result = await pollJobStatus(taskId, 600, 5000, `Kling ${version} (KIE.AI)`);

    const videoUrl = extractVideoUrl(result);
    if (!videoUrl) {
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      taskId: taskId,
      provider: 'kie-ai',
      version: version
    };

  } catch (error) {
    console.error(`❌ KIE.AI Kling Error:`, {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      stack: error.stack
    });

    // Формуємо зрозуміле повідомлення для користувача
    let errorMessage = error.message;

    if (error.response?.data) {
      const apiError = error.response.data;
      if (apiError.msg) {
        errorMessage = apiError.msg;
      } else if (apiError.message) {
        errorMessage = apiError.message;
      } else if (apiError.error) {
        errorMessage = apiError.error;
      }
    }

    return {
      success: false,
      error: errorMessage,
      provider: 'kie-ai',
      details: error.response?.data
    };
  }
}

/**
 * Генерація через KIE.AI - Runway
 *
 * Документація: https://docs.kie.ai/runway-api/quickstart
 *
 * ⚠️ УВАГА: Runway використовує ІНШИЙ endpoint: /runway/generate (не /jobs/createTask)
 * ⚠️ УВАГА: Статус перевіряється через /runway/record-detail?taskId=...
 *
 * Типи генерації:
 * - Text-to-Video: тільки prompt
 * - Image-to-Video: prompt + imageUrl
 *
 * Параметри:
 * - prompt: текстовий опис (обов'язково)
 * - imageUrl: URL зображення (опційно, для image-to-video)
 * - duration: 5 або 10 (number!)
 * - quality: '720p' або '1080p' (1080p тільки для 5 сек)
 * - aspectRatio: '16:9', '9:16', '1:1', '4:3', '3:4'
 * - waterMark: текст водяного знаку (опційно)
 */
async function generateRunwayVideoKieAI(prompt, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!prompt) {
      throw new Error('Prompt є обов\'язковим для Runway');
    }

    const {
      imageUrl = null,         // URL зображення для image-to-video
      duration = 5,            // 5 або 10 (number!)
      quality = '720p',        // '720p' або '1080p'
      aspectRatio = '16:9',    // '16:9', '9:16', '1:1', '4:3', '3:4'
      waterMark = '',          // текст водяного знаку
      callBackUrl = null       // callback URL
    } = options;

    // Перевірка: 1080p тільки для 5 секунд
    if (quality === '1080p' && duration !== 5) {
      console.warn('⚠️ 1080p доступний тільки для 5-секундних відео, змінюємо на 720p');
    }

    const actualQuality = (quality === '1080p' && duration !== 5) ? '720p' : quality;

    console.log(`🎬 KIE.AI Runway (${imageUrl ? 'image2video' : 'text2video'}):`, {
      prompt: prompt.substring(0, 100),
      duration,
      quality: actualQuality,
      aspectRatio,
      hasImage: !!imageUrl
    });

    // ✅ Структура за документацією KIE.AI
    // https://docs.kie.ai/runway-api/generate-ai-video
    const payload = {
      prompt: prompt,
      duration: duration,  // number, не string!
      quality: actualQuality,
      aspectRatio: aspectRatio,
      waterMark: waterMark
    };

    // Для image-to-video додаємо imageUrl
    if (imageUrl) {
      payload.imageUrl = imageUrl;
    }

    // Callback URL
    if (callBackUrl) {
      payload.callBackUrl = callBackUrl;
    } else {
      payload.callBackUrl = `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai-runway`;
    }

    console.log(`📤 KIE.AI Runway request:`, {
      mode: imageUrl ? 'image2video' : 'text2video',
      duration,
      quality: actualQuality,
      aspectRatio
    });

    // ⚠️ УВАГА: Runway використовує ІНШИЙ endpoint!
    const createResponse = await axios.post(
      `${KIE_API_BASE}/runway/generate`,  // НЕ /jobs/createTask!
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Runway response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI Runway response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI Runway: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI Runway task created: ${taskId}`);

    // Runway відео: до ~50 хв
    const result = await pollRunwayStatus(taskId, 600, 5000, 'Runway (KIE.AI)');

    // Отримуємо URL відео
    const videoUrl = result.videoInfo?.videoUrl;
    if (!videoUrl) {
      throw new Error('KIE.AI Runway returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      thumbnailUrl: result.videoInfo?.imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Runway Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

/**
 * Polling для Runway - використовує ІНШИЙ endpoint!
 * /runway/record-detail?taskId=...
 *
 * Статуси: wait, queueing, generating, success, fail
 */
async function pollRunwayStatus(taskId, maxAttempts = 600, interval = 5000, modelName = 'Runway') {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      // ⚠️ Runway має свій endpoint для статусу!
      const response = await axios.get(
        `${KIE_API_BASE}/runway/record-detail?taskId=${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`
          }
        }
      );

      const task = response.data.data;
      const state = task.state;

      console.log(`📊 ${modelName} status (attempt ${attempts + 1}): ${state}`);

      if (state === 'success') {
        return task;
      } else if (state === 'fail') {
        const errorMsg = task.failMsg || 'Unknown error';
        throw new Error(`Task failed: ${errorMsg}`);
      }
      // wait, queueing, generating - продовжуємо polling

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;

    } catch (error) {
      if (error.message.includes('Task failed')) {
        throw error;
      }
      console.error(`⚠️ Polling error:`, error.message);

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    }
  }

  // Остання спроба перед таймаутом
  try {
    const last = await axios.get(`${KIE_API_BASE}/runway/record-detail?taskId=${taskId}`, {
      headers: { 'Authorization': `Bearer ${KIE_API_KEY}` }
    });
    const task = last.data?.data;
    if (task?.state === 'success') {
      console.log(`📊 ${modelName} got result on final check`);
      return task;
    }
  } catch (e) { /* ігноруємо */ }

  throw new Error(`Timeout waiting for ${modelName} task completion (${taskId})`);
}

/**
 * Генерація через KIE.AI - Google Veo 3.1
 *
 * Документація: https://docs.kie.ai/market/google/veo-3.1
 *
 * ⚠️ УВАГА: Veo використовує ІНШИЙ endpoint: /veo/generate (не /jobs/createTask)
 *
 * Моделі:
 * - veo3: Veo 3.1 Quality - найвища якість
 * - veo3_fast: Veo 3.1 Fast - швидший, дешевший
 *
 * Режими генерації (generationType):
 * - TEXT_2_VIDEO: тільки текст → відео
 * - FIRST_AND_LAST_FRAMES_2_VIDEO: 1-2 зображення (перший/останній кадр)
 * - REFERENCE_2_VIDEO: 1-3 референс зображення (тільки veo3_fast, тільки 16:9)
 *
 * Параметри:
 * - prompt: текстовий опис (обов'язково)
 * - imageUrls: масив URL зображень (опційно, 1-3 залежно від режиму)
 * - model: 'veo3' або 'veo3_fast' (default: 'veo3_fast')
 * - aspectRatio: '16:9', '9:16', 'Auto'
 * - generationType: режим генерації (auto якщо не вказано)
 * - enableTranslation: true/false (автопереклад на англійську)
 */
async function generateVeoKieAI(prompt, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!prompt) {
      throw new Error('Prompt є обов\'язковим для Veo');
    }

    const {
      imageUrls = [],           // масив URL зображень
      model = 'veo3_fast',      // 'veo3' або 'veo3_fast'
      aspectRatio = '16:9',     // '16:9', '9:16', 'Auto'
      generationType = null,    // TEXT_2_VIDEO, FIRST_AND_LAST_FRAMES_2_VIDEO, REFERENCE_2_VIDEO
      enableTranslation = true, // автопереклад промпту на англійську
      watermark = null,         // текст водяного знаку
      seeds = null              // random seed 10000-99999
    } = options;

    // Визначаємо режим генерації автоматично якщо не вказано
    let actualGenerationType = generationType;
    if (!actualGenerationType) {
      if (imageUrls.length === 0) {
        actualGenerationType = 'TEXT_2_VIDEO';
      } else if (imageUrls.length <= 2) {
        actualGenerationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO';
      } else {
        actualGenerationType = 'REFERENCE_2_VIDEO';
      }
    }

    // Перевірки для REFERENCE_2_VIDEO
    if (actualGenerationType === 'REFERENCE_2_VIDEO') {
      if (model !== 'veo3_fast') {
        console.warn('⚠️ REFERENCE_2_VIDEO підтримує тільки veo3_fast, змінюємо модель');
      }
      if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
        console.warn('⚠️ REFERENCE_2_VIDEO підтримує тільки 16:9 та 9:16');
      }
    }

    console.log(`🎥 KIE.AI Veo 3.1 (${actualGenerationType}):`, {
      prompt: prompt.substring(0, 100),
      model,
      aspectRatio,
      generationType: actualGenerationType,
      imageCount: imageUrls.length,
      enableTranslation
    });

    // ✅ Структура за документацією KIE.AI
    // https://docs.kie.ai/market/google/veo-3.1
    const payload = {
      prompt: prompt,
      model: actualGenerationType === 'REFERENCE_2_VIDEO' ? 'veo3_fast' : model,
      aspect_ratio: aspectRatio,
      generationType: actualGenerationType,
      enableTranslation: enableTranslation,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`
    };

    // Додаємо зображення якщо є
    if (imageUrls.length > 0) {
      payload.imageUrls = imageUrls.slice(0, 3); // максимум 3
    }

    // Опційні параметри
    if (watermark) {
      payload.watermark = watermark;
    }

    if (seeds && seeds >= 10000 && seeds <= 99999) {
      payload.seeds = seeds;
    }

    console.log(`📤 KIE.AI Veo request:`, {
      model: payload.model,
      generationType: payload.generationType,
      aspectRatio: payload.aspect_ratio,
      images: payload.imageUrls?.length || 0
    });

    // ⚠️ УВАГА: Veo використовує ІНШИЙ endpoint!
    const createResponse = await axios.post(
      `${KIE_API_BASE}/veo/generate`,  // НЕ /jobs/createTask!
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Veo response:`, JSON.stringify(createResponse.data, null, 2));

    // Перевіряємо структуру відповіді
    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI Veo response structure:', createResponse.data);
      throw new Error(`Неочікувана відповідь від KIE.AI Veo: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI Veo task created: ${taskId}`);

    // Veo відео: до ~50 хв
    const result = await pollVeoStatus(taskId, 600, 5000, 'Veo 3.1 (KIE.AI)');

    // Отримуємо URL відео
    const videoUrl = extractVideoUrl(result);
    if (!videoUrl) {
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      taskId: taskId,
      provider: 'kie-ai',
      model: payload.model,
      generationType: actualGenerationType
    };

  } catch (error) {
    console.error('❌ KIE.AI Veo Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

/**
 * Polling для Veo (може мати інший endpoint для статусу)
 */
async function pollVeoStatus(taskId, maxAttempts = 600, interval = 5000, modelName = 'Veo') {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const job = await fetchTaskRecordInfo(taskId);
      if (!job) {
        await new Promise(resolve => setTimeout(resolve, interval));
        attempts++;
        continue;
      }

      const state = (job.state || job.status || '').toLowerCase();

      console.log(`📊 ${modelName} status (attempt ${attempts + 1}): ${state}`);

      if (state === 'success' || state === 'completed') {
        return job;
      }
      if (state === 'fail' || state === 'failed' || state === 'error') {
        const errorMsg = job.failMsg || job.failCode || job.error || 'Unknown error';
        throw new Error(`Task failed: ${errorMsg}`);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`⚠️ Task ${taskId} not found, retrying...`);
      } else if (error.message.includes('Task failed')) {
        throw error;
      } else {
        console.error(`⚠️ Polling error:`, error.message);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    }
  }

  // Остання спроба перед таймаутом
  try {
    const job = await fetchTaskRecordInfo(taskId);
    const state = (job?.state || job?.status || '').toLowerCase();
    if (state === 'success' || state === 'completed') {
      console.log(`📊 ${modelName} got result on final check`);
      return job;
    }
  } catch (e) { /* ігноруємо */ }

  throw new Error(`Timeout waiting for ${modelName} task completion (${taskId})`);
}


// ==================== EXPORT ====================

module.exports = {
  // Перевірки
  isAdminUser,

  // Генерація зображень
  generateWithNanoBananaKieAI,
  generateWithSeedreamKieAI,
  generateWithStableDiffusionKieAI,  // ❌ Повертає помилку - не підтримується
  generateWithIdeogramKieAI,         // ✅ Ideogram v3
  generateWithRecraftUpscaleKieAI,   // ✅ Recraft Crisp Upscale

  // Генерація відео
  generateKlingMotionKieAI,          // ✅ Kling Motion Control
  generateKling3VideoKieAI,          // ✅ Kling 3.0 (multi-shot, element refs)
  generateKlingVideoKieAI,           // ✅ Kling v2.5 + v2.6
  generateRunwayVideoKieAI,          // ✅ Runway (endpoint: /runway/generate)
  generateVeoKieAI,                  // ✅ Veo 3.1 (endpoint: /veo/generate)

  // Інформація про провайдер
  KIE_API_BASE,
  KIE_API_KEY: !!KIE_API_KEY,
  isKieAIEnabled: !!KIE_API_KEY,

  // Підтримувані моделі на KIE.AI
  SUPPORTED_MODELS: {
    image: [
      'nano_banana',      // ✅ nano-banana-pro (1K)
      'nano_banana_2k',   // ✅ nano-banana-pro (2K)
      'nano_banana_4k',   // ✅ nano-banana-pro (4K)
      'seedream_4k',      // ✅ seedream/4.5-text-to-image, seedream/4.5-edit
      'ideogram',         // ✅ ideogram/v3-reframe, v3-remix, v3-edit
      'recraft_upscale'   // ✅ recraft/crisp-upscale
    ],
    video: [
      'kling',            // ✅ kling/v2-5-turbo-image-to-video-pro
      'kling_v2_6',       // ✅ kling-2.6/text-to-video, kling-2.6/image-to-video
      'kling_3',          // ✅ kling-3.0/video (multi-shot, element refs) 🆕
      'kling_motion',     // ✅ kling-2.6/motion-control
      'runway_turbo',     // ✅ /runway/generate (endpoint!)
      'veo'               // ✅ veo3, veo3_fast (/veo/generate endpoint!)
    ],
    // Моделі які ТІЛЬКИ на KIE.AI - немає на Replicate!
    kieAIOnly: [
      'kling_3'           // ⚠️ Kling 3.0 - немає на Replicate
    ],
    // Моделі які НЕ підтримуються на KIE.AI — ціна та запуск через Replicate
    notSupported: [
      'stable_diffusion', // ❌ Немає на KIE.AI
      'clarity',          // ❌ Немає на KIE.AI
      'sora_2'            // ❌ Поки тільки Replicate
    ]
  },

  /**
   * Чи є реалізація моделі на KIE.AI (ціна KIE + виклик KIE).
   * Якщо false — показуємо/списуємо ціну Replicate і запускаємо Replicate.
   */
  isKieAIImplemented(modelKey) {
    const img = this.SUPPORTED_MODELS.image.includes(modelKey);
    const vid = this.SUPPORTED_MODELS.video.includes(modelKey);
    const not = this.SUPPORTED_MODELS.notSupported.includes(modelKey);
    return (img || vid) && !not;
  },

  // Маппінг наших ключів моделей на KIE.AI моделі
  MODEL_MAPPING: {
    // Image
    nano_banana: { model: 'nano-banana-pro', resolution: '1K' },
    nano_banana_2k: { model: 'nano-banana-pro', resolution: '2K' },
    nano_banana_4k: { model: 'nano-banana-pro', resolution: '4K' },
    seedream_4k: { model: 'seedream/4.5-text-to-image', edit: 'seedream/4.5-edit' },
    ideogram: { model: 'ideogram/v3-reframe', remix: 'ideogram/v3-remix', edit: 'ideogram/v3-edit' },
    recraft_upscale: { model: 'recraft/crisp-upscale' },

    // Video
    kling: { model: 'kling/v2-5-turbo-image-to-video-pro' },
    kling_v2_6: { model: 'kling-2.6/text-to-video', image: 'kling-2.6/image-to-video' },
    kling_3: { model: 'kling-3.0/video', features: ['multi-shot', 'element-refs'] },
    kling_motion: { model: 'kling-2.6/motion-control' },
    runway_turbo: { endpoint: '/runway/generate', quality: ['720p', '1080p'] },
    veo: { model: 'veo3_fast', quality: 'veo3', endpoint: '/veo/generate' }
  },

  // Endpoints для різних моделей (статус — офіційно GET /jobs/recordInfo?taskId=)
  SPECIAL_ENDPOINTS: {
    runway: '/runway/generate',
    runway_status: '/runway/record-detail',
    veo: '/veo/generate',
    jobs: '/jobs/createTask',
    jobs_recordInfo: '/jobs/recordInfo'
  }
};

