/**
 * KIE.AI провайдер для генерацій через api.kie.ai
 * Документація: https://docs.kie.ai/market/google/pro-image-to-image
 *
 * Альтернатива до Replicate для адміністраторів
 */

const axios = require('axios');

const KIE_API_BASE = 'https://api.kie.ai/api/v1';
const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

// ==================== HELPER FUNCTIONS ====================

/**
 * Перевіряємо чи користувач є адміном
 */
function isAdminUser(userId) {
  if (!ADMIN_TELEGRAM_ID) return false;
  return String(userId) === String(ADMIN_TELEGRAM_ID);
}

/**
 * Polling для отримання результату від KIE.AI API
 */
async function pollJobStatus(jobId, maxAttempts = 120, interval = 1000, modelName = 'KIE.AI') {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const response = await axios.get(
        `${KIE_API_BASE}/jobs/${jobId}`,
        {
          headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const job = response.data.data;
      console.log(`📊 ${modelName} job status (attempt ${attempts + 1}): ${job.status}`);

      if (job.status === 'completed') {
        return job;
      } else if (job.status === 'failed') {
        throw new Error(`Job failed: ${job.error || 'Unknown error'}`);
      } else if (job.status === 'error') {
        throw new Error(`Job error: ${job.error || 'Unknown error'}`);
      }

      // Очікуємо перед наступною спробою
      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;

    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`⚠️ Job ${jobId} not found, retrying...`);
      } else {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    }
  }

  throw new Error(`Timeout waiting for ${modelName} job completion (${jobId})`);
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

// ==================== IMAGE GENERATION ====================

/**
 * Генерація зображення через KIE.AI - Nano Banana Pro (Pro Image-to-Image)
 *
 * Параметри:
 * - prompt: текстовий опис
 * - imageInput: URL або масив URL зображень (до 3)
 * - resolution: "2K" або "4K" (default: "2K")
 * - aspectRatio: "match_input_image", "1:1", "4:5", "9:16" (default: "match_input_image")
 * - strength: 0-1 (як сильно впливає референс на результат, default: 0.5)
 *
 * Документація: https://docs.kie.ai/market/google/pro-image-to-image
 */
async function generateWithNanoBananaKieAI(prompt, imageInput = null, resolution = "2K", aspectRatio = "match_input_image", strength = 0.5) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!imageInput) {
      throw new Error('KIE.AI вимагає зображення для Nano Banana Pro (img2img)');
    }

    console.log(`🎨 KIE.AI Nano Banana Pro generation:`, {
      prompt: prompt.substring(0, 100),
      resolution,
      aspectRatio,
      strength,
      imageCount: Array.isArray(imageInput) ? imageInput.length : 1
    });

    const images = normalizeImageInput(imageInput, 3);

    // КІЕ.АІ дозволяє завантажувати одну основну референс-цінність з особливими настройками
    const payload = {
      model: "google/nano-banana-pro",
      task_type: "img2img",
      input: {
        prompt: prompt,
        image: images[0],  // основне референс зображення
        resolution: resolution,  // "2K" або "4K"
        aspect_ratio: aspectRatio,
        strength: Math.min(Math.max(strength, 0), 1)  // 0-1
      }
    };

    // Якщо є більше зображень, можна додати як додаткові референси (якщо API це підтримує)
    if (images.length > 1) {
      console.log(`⚠️ KIE.AI підтримує 1 основне зображення; інші ${images.length - 1} проігноруються`);
    }

    console.log(`📤 Sending KIE.AI request:`, {
      model: payload.model,
      task_type: payload.task_type,
      input_keys: Object.keys(payload.input)
    });

    // Створюємо задачу на KIE.AI
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

    const jobId = createResponse.data.data.id;
    console.log(`✅ KIE.AI job created: ${jobId}`);

    // Очікуємо на результат
    const result = await pollJobStatus(jobId, 120, 2000, 'Nano Banana Pro (KIE.AI)');

    if (!result.output || !result.output.image) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: result.output.image,
      jobId: jobId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

/**
 * Генерація через KIE.AI - Seedream (Pro Image-to-Image)
 *
 * Документація: https://docs.kie.ai/market/google/pro-image-to-image
 */
async function generateWithSeedreamKieAI(prompt, imageInput = null, size = "4K", aspectRatio = "match_input_image", strength = 0.5) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    if (!imageInput) {
      throw new Error('KIE.AI Seedream вимагає зображення (img2img)');
    }

    console.log(`🎨 KIE.AI Seedream generation:`, {
      prompt: prompt.substring(0, 100),
      size,
      aspectRatio,
      strength
    });

    const images = normalizeImageInput(imageInput, 3);

    const payload = {
      model: "bytedance/seedream-4.5",
      task_type: "img2img",
      input: {
        prompt: prompt,
        image: images[0],
        size: size,  // "1K", "2K", "4K"
        aspect_ratio: aspectRatio,
        strength: Math.min(Math.max(strength, 0), 1)
      }
    };

    console.log(`📤 Sending KIE.AI request:`, {
      model: payload.model,
      task_type: payload.task_type
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

    const jobId = createResponse.data.data.id;
    console.log(`✅ KIE.AI job created: ${jobId}`);

    const result = await pollJobStatus(jobId, 120, 2000, 'Seedream (KIE.AI)');

    if (!result.output || !result.output.image) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: result.output.image,
      jobId: jobId,
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
 * Генерація через KIE.AI - Stable Diffusion (text2img або img2img)
 */
async function generateWithStableDiffusionKieAI(prompt, imageInput = null, aspectRatio = "1:1", strength = 0.5) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY не встановлена в .env');
    }

    console.log(`🎨 KIE.AI Stable Diffusion generation:`, {
      prompt: prompt.substring(0, 100),
      aspectRatio,
      hasImage: !!imageInput
    });

    const taskType = imageInput ? "img2img" : "text2img";
    const images = imageInput ? normalizeImageInput(imageInput, 1) : null;

    const input = {
      prompt: prompt,
      aspect_ratio: aspectRatio
    };

    if (imageInput && images.length > 0) {
      input.image = images[0];
      input.strength = Math.min(Math.max(strength, 0), 1);
    }

    const payload = {
      model: "stability-ai/stable-diffusion-3.5-large",
      task_type: taskType,
      input: input
    };

    console.log(`📤 Sending KIE.AI request (${taskType})`);

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

    const jobId = createResponse.data.data.id;
    console.log(`✅ KIE.AI job created: ${jobId}`);

    const result = await pollJobStatus(jobId, 120, 2000, 'Stable Diffusion (KIE.AI)');

    if (!result.output || !result.output.image) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: result.output.image,
      jobId: jobId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Stable Diffusion Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

// ==================== EXPORT ====================

module.exports = {
  // Перевірки
  isAdminUser,

  // Генерація зображень
  generateWithNanoBananaKieAI,
  generateWithSeedreamKieAI,
  generateWithStableDiffusionKieAI,

  // Інформація про провайдер
  KIE_API_BASE,
  KIE_API_KEY: !!KIE_API_KEY,  // true/false замість ключа
  isKieAIEnabled: !!KIE_API_KEY
};

