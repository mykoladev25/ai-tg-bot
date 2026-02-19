const axios = require('axios');

const KIE_API_KEY = process.env.KIE_API_KEY;
const KIE_BASE_URL = 'https://api.kie.ai/api/v1/jobs';

/**
 * Видалення watermark з Sora відео
 * @param {string} videoUrl - URL Sora відео (sora.chatgpt.com/p/s_... або /g/gen_...)
 * @param {string} uploadMethod - 's3' або 'oss' (за замовчуванням 's3')
 * @returns {Promise<Object>} - { success: boolean, taskId?: string, error?: string }
 */
async function removeSoraWatermark(videoUrl, uploadMethod = 's3') {
  try {
    // Перевірка URL - має бути з sora.chatgpt.com
    if (!videoUrl.includes('sora.chatgpt.com')) {
      return {
        success: false,
        error: 'URL має бути з sora.chatgpt.com'
      };
    }

    // Приймаємо обидва формати: /p/s_... та /g/gen_...
    // API сам визначить чи має доступ

    console.log('🧹 Sora Watermark: Creating task for URL:', videoUrl);

    const response = await axios.post(
      `${KIE_BASE_URL}/createTask`,
      {
        model: 'sora-watermark-remover',
        input: {
          video_url: videoUrl,
          upload_method: uploadMethod
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('🧹 Sora Watermark: API response:', {
      code: response.data.code,
      msg: response.data.msg,
      taskId: response.data.data?.taskId
    });

    if (response.data.code === 200 && response.data.data?.taskId) {
      return {
        success: true,
        taskId: response.data.data.taskId
      };
    } else {
      return {
        success: false,
        error: response.data.msg || 'Не вдалося створити задачу'
      };
    }
  } catch (error) {
    console.error('❌ Sora Watermark Remover Error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

/**
 * Перевірка статусу задачі
 * @param {string} taskId - ID задачі
 * @returns {Promise<Object>} - { success: boolean, state: string, resultUrls?: array, error?: string }
 */
async function checkTaskStatus(taskId) {
  try {
    const response = await axios.get(
      `${KIE_BASE_URL}/recordInfo`,
      {
        params: { taskId },
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`
        }
      }
    );

    if (response.data.code === 200) {
      const data = response.data.data;
      const state = data.state; // 'waiting', 'success', 'fail'

      if (state === 'success' && data.resultJson) {
        const result = JSON.parse(data.resultJson);
        return {
          success: true,
          state: 'success',
          resultUrls: result.resultUrls || []
        };
      } else if (state === 'fail') {
        return {
          success: false,
          state: 'fail',
          error: data.failMsg || 'Генерація провалилася'
        };
      } else {
        return {
          success: true,
          state: 'waiting'
        };
      }
    } else {
      return {
        success: false,
        error: response.data.msg || 'Помилка перевірки статусу'
      };
    }
  } catch (error) {
    console.error('❌ Check Task Status Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

/**
 * Видалення watermark з очікуванням результату
 * @param {string} videoUrl - URL Sora відео
 * @param {string} uploadMethod - 's3' або 'oss'
 * @param {number} maxRetries - максимальна кількість спроб перевірки (за замовчуванням 60)
 * @param {number} retryDelay - затримка між спробами в мс (за замовчуванням 5000)
 * @returns {Promise<Object>} - { success: boolean, videoUrl?: string, error?: string }
 */
async function removeSoraWatermarkWithWait(videoUrl, uploadMethod = 's3', maxRetries = 60, retryDelay = 5000) {
  const createResult = await removeSoraWatermark(videoUrl, uploadMethod);

  if (!createResult.success) {
    return createResult;
  }

  const taskId = createResult.taskId;
  let retries = 0;

  while (retries < maxRetries) {
    await new Promise(resolve => setTimeout(resolve, retryDelay));

    const status = await checkTaskStatus(taskId);

    if (status.state === 'success') {
      return {
        success: true,
        videoUrl: status.resultUrls?.[0],
        taskId
      };
    } else if (status.state === 'fail') {
      return {
        success: false,
        error: status.error
      };
    }

    retries++;
  }

  return {
    success: false,
    error: 'Перевищено час очікування'
  };
}

module.exports = {
  removeSoraWatermark,
  checkTaskStatus,
  removeSoraWatermarkWithWait
};

