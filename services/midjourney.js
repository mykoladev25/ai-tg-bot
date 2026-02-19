const axios = require('axios');

const KIE_API_BASE = 'https://api.kie.ai';
const KIE_API_KEY = process.env.KIE_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://neurolab.fun/webhook/kie-ai';

/**
 * =====================================================
 * MIDJOURNEY API SERVICE (KIE.AI)
 * =====================================================
 *
 * API Documentation:
 * - Generate: https://docs.kie.ai/mj-api/generate-midjourney-image
 * - Get Status: https://docs.kie.ai/mj-api/get-midjourney-task-details
 * - Upscale: https://docs.kie.ai/mj-api/upscale
 * - Vary: https://docs.kie.ai/mj-api/vary
 *
 * Pricing:
 * - Text-to-image (relaxed): 3 credits = $0.015
 * - Text-to-image (fast): 8 credits = $0.04
 * - Text-to-image (turbo): 16 credits = $0.08
 * - Image-to-image (same pricing as text-to-image)
 * - Image-to-video: 60 credits = $0.30
 * - Upscale: безкоштовно
 * - Vary: безкоштовно
 */

/**
 * Генерація зображення через Midjourney
 * @param {Object} options - Параметри генерації
 * @param {string} options.prompt - Текстовий опис
 * @param {string} options.taskType - Тип задачі (mj_txt2img, mj_img2img, mj_video, mj_style_reference, mj_omni_reference)
 * @param {string} [options.speed='fast'] - Швидкість (relaxed, fast, turbo)
 * @param {string} [options.fileUrl] - URL зображення (для img2img, video)
 * @param {string[]} [options.fileUrls] - Масив URL зображень (рекомендовано)
 * @param {string} [options.aspectRatio='1:1'] - Пропорції
 * @param {string} [options.version='7'] - Версія моделі
 * @param {number} [options.variety=10] - Різноманітність (0-100)
 * @param {number} [options.stylization=1] - Стилізація (0-1000)
 * @param {number} [options.weirdness=1] - Дивність (0-3000)
 * @param {number} [options.ow=500] - Omni intensity (для mj_omni_reference)
 * @param {string} [options.waterMark] - Водяний знак
 * @returns {Promise<Object>} Результат генерації з taskId
 */
async function generateImage(options) {
  try {
    const {
      prompt,
      taskType = 'mj_txt2img',
      speed = 'fast',
      fileUrl,
      fileUrls,
      aspectRatio = '1:1',
      version = '7',
      variety = 10,
      stylization = 1,
      weirdness = 1,
      ow = 500,
      waterMark = ''
    } = options;

    console.log('🖼️ Midjourney: Starting generation', {
      taskType,
      speed,
      hasFileUrl: !!fileUrl,
      hasFileUrls: !!fileUrls,
      prompt: prompt?.substring(0, 100)
    });

    const payload = {
      taskType,
      prompt,
      speed,
      aspectRatio,
      version,
      variety,
      stylization,
      weirdness,
      waterMark,
      callBackUrl: WEBHOOK_URL
    };

    // Додаємо файли якщо є
    if (fileUrls && fileUrls.length > 0) {
      payload.fileUrls = fileUrls;
    } else if (fileUrl) {
      payload.fileUrl = fileUrl;
    }

    // Додаємо ow для omni reference
    if (taskType === 'mj_omni_reference') {
      payload.ow = ow;
    }

    // Не передаємо speed для video та omni reference
    if (taskType === 'mj_video' || taskType === 'mj_omni_reference') {
      delete payload.speed;
    }

    console.log('📤 Midjourney API Request:', JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `${KIE_API_BASE}/api/v1/mj/generate`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Midjourney API Response:', JSON.stringify(response.data, null, 2));

    if (response.data.code === 200 && response.data.data?.taskId) {
      return {
        success: true,
        taskId: response.data.data.taskId
      };
    } else {
      throw new Error(response.data.msg || 'Unknown error');
    }

  } catch (error) {
    console.error('❌ Midjourney API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

/**
 * Отримати статус задачі Midjourney
 * @param {string} taskId - ID задачі
 * @returns {Promise<Object>} Статус та результати
 */
async function getTaskStatus(taskId) {
  try {
    const response = await axios.get(
      `${KIE_API_BASE}/api/v1/mj/record-info`,
      {
        params: { taskId },
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`
        }
      }
    );

    console.log('🔍 Midjourney Status Response:', JSON.stringify(response.data, null, 2));

    if (response.data.code === 200 && response.data.data) {
      const data = response.data.data;

      return {
        success: true,
        taskId: data.taskId,
        taskType: data.taskType,
        status: data.successFlag,  // 0=Generating, 1=Success, 2=Failed, 3=Generation Failed
        resultUrls: data.resultInfoJson?.resultUrls?.map(item => item.resultUrl) || [],
        errorCode: data.errorCode,
        errorMessage: data.errorMessage,
        createTime: data.createTime,
        completeTime: data.completeTime,
        paramJson: data.paramJson
      };
    } else {
      throw new Error(response.data.msg || 'Unknown error');
    }

  } catch (error) {
    console.error('❌ Midjourney getTaskStatus Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

/**
 * Upscale зображення (безкоштовно)
 * @param {string} taskId - ID оригінальної задачі
 * @param {number} imageIndex - Індекс зображення (1-4)
 * @param {string} [waterMark] - Водяний знак
 * @returns {Promise<Object>} Результат з новим taskId
 */
async function upscaleImage(taskId, imageIndex, waterMark = '') {
  try {
    console.log('🔍 Midjourney: Starting upscale', { taskId, imageIndex });

    const response = await axios.post(
      `${KIE_API_BASE}/api/v1/mj/generateUpscale`,
      {
        taskId,
        imageIndex: imageIndex - 1,  // API використовує 0-based index
        waterMark,
        callBackUrl: WEBHOOK_URL
      },
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Midjourney Upscale Response:', JSON.stringify(response.data, null, 2));

    if (response.data.code === 200 && response.data.data?.taskId) {
      return {
        success: true,
        taskId: response.data.data.taskId
      };
    } else {
      throw new Error(response.data.msg || 'Unknown error');
    }

  } catch (error) {
    console.error('❌ Midjourney Upscale Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

/**
 * Створити варіації зображення (безкоштовно)
 * @param {string} taskId - ID оригінальної задачі
 * @param {number} imageIndex - Індекс зображення (1-4)
 * @param {string} [waterMark] - Водяний знак
 * @returns {Promise<Object>} Результат з новим taskId
 */
async function variateImage(taskId, imageIndex, waterMark = '') {
  try {
    console.log('🎨 Midjourney: Starting vary', { taskId, imageIndex });

    const response = await axios.post(
      `${KIE_API_BASE}/api/v1/mj/generateVary`,
      {
        taskId,
        imageIndex,  // API використовує 1-based index для vary
        waterMark,
        callBackUrl: WEBHOOK_URL
      },
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Midjourney Vary Response:', JSON.stringify(response.data, null, 2));

    if (response.data.code === 200 && response.data.data?.taskId) {
      return {
        success: true,
        taskId: response.data.data.taskId
      };
    } else {
      throw new Error(response.data.msg || 'Unknown error');
    }

  } catch (error) {
    console.error('❌ Midjourney Vary Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

/**
 * Чекати завершення задачі (polling)
 * @param {string} taskId - ID задачі
 * @param {number} [maxAttempts=60] - Максимальна кількість спроб
 * @param {number} [interval=5000] - Інтервал між спробами (мс)
 * @returns {Promise<Object>} Результат задачі
 */
async function waitForCompletion(taskId, maxAttempts = 60, interval = 5000) {
  console.log('⏳ Waiting for Midjourney task completion:', taskId);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    const status = await getTaskStatus(taskId);

    if (!status.success) {
      return status;
    }

    console.log(`⏳ Attempt ${attempt}/${maxAttempts}: Status = ${status.status}`);

    // successFlag: 0=Generating, 1=Success, 2=Failed, 3=Generation Failed
    if (status.status === 1) {
      console.log('✅ Midjourney task completed successfully');
      return {
        success: true,
        ...status
      };
    } else if (status.status === 2 || status.status === 3) {
      console.error('❌ Midjourney task failed:', status.errorMessage);
      return {
        success: false,
        error: status.errorMessage || 'Generation failed'
      };
    }
  }

  console.error('⏱️ Midjourney task timeout');
  return {
    success: false,
    error: 'Timeout waiting for generation'
  };
}

module.exports = {
  generateImage,
  getTaskStatus,
  upscaleImage,
  variateImage,
  waitForCompletion
};
