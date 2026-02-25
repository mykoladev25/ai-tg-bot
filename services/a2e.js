const axios = require('axios');

const A2E_API_BASE = 'https://video.a2e.ai/api/v1';
const A2E_API_TOKEN = process.env.A2E_API_TOKEN;

if (!A2E_API_TOKEN) {
  console.warn('⚠️ A2E_API_TOKEN not set in environment variables');
}

/**
 * Створює задачу генерації відео з зображення через A2E API
 * 
 * @param {Object} options - Параметри генерації
 * @param {string} options.imageUrl - URL зображення
 * @param {string} options.prompt - Промпт для генерації
 * @param {string} [options.negativePrompt] - Негативний промпт
 * @param {number} [options.videoTime=5] - Тривалість відео (5, 10, 15, 20 секунд)
 * @param {string} [options.modelType='GENERAL'] - Тип моделі (GENERAL або FLF2V)
 * @param {string} [options.endImageUrl] - URL кінцевого зображення (для FLF2V)
 * @param {boolean} [options.extendPrompt=true] - Автоматично розширювати промпт
 * @param {boolean} [options.skipFaceEnhance=false] - Пропустити покращення обличчя
 * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
 */
async function startImageToVideoTask(options = {}) {
  try {
    const {
      imageUrl,
      prompt,
      negativePrompt = 'blurry, low quality, chaotic, deformed, watermark, bad anatomy, shaky camera view point',
      videoTime = 5,
      modelType = 'GENERAL',
      endImageUrl = null,
      extendPrompt = true,
      skipFaceEnhance = false
    } = options;

    if (!imageUrl) {
      throw new Error('imageUrl є обов\'язковим параметром');
    }

    if (!prompt) {
      throw new Error('prompt є обов\'язковим параметром');
    }

    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN не налаштовано');
    }

    // Валідація videoTime
    const validVideoTimes = [5, 10, 15, 20];
    if (!validVideoTimes.includes(videoTime)) {
      throw new Error(`videoTime має бути одним з: ${validVideoTimes.join(', ')}`);
    }

    // Для FLF2V потрібен endImageUrl
    if (modelType === 'FLF2V' && !endImageUrl) {
      throw new Error('endImageUrl є обов\'язковим для моделі FLF2V');
    }

    const requestBody = {
      name: `A2E_${Date.now()}`,
      image_url: imageUrl,
      prompt: prompt,
      negative_prompt: negativePrompt,
      model_type: modelType,
      video_time: videoTime,
      extend_prompt: extendPrompt,
      skip_face_enhance: skipFaceEnhance
    };

    if (endImageUrl) {
      requestBody.end_image_url = endImageUrl;
    }

    console.log(`🔥 A2E: Starting image-to-video task:`, {
      modelType,
      videoTime,
      hasEndImage: !!endImageUrl,
      prompt: prompt.substring(0, 50)
    });

    const response = await axios.post(
      `${A2E_API_BASE}/userImage2Video/start`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (response.data && response.data.code === 0) {
      const taskId = response.data.data?._id || response.data.data?.taskId || response.data.data?.id;
      return {
        success: true,
        taskId: taskId
      };
    } else {
      const errorMsg = response.data?.message || 'Unknown error';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('A2E API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message || 'A2E API error'
    };
  }
}

/**
 * Отримує інформацію про задачу генерації
 * 
 * @param {string} taskId - ID задачі
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
async function getTaskDetails(taskId) {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN не налаштовано');
    }

    const response = await axios.get(
      `${A2E_API_BASE}/userImage2Video/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.code === 0) {
      return {
        success: true,
        data: response.data.data
      };
    } else {
      const errorMsg = response.data?.message || 'Unknown error';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('A2E Get Task Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message || 'A2E API error'
    };
  }
}

/**
 * Отримує всі записи задач користувача
 * 
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
async function getAllRecords() {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN не налаштовано');
    }

    const response = await axios.get(
      `${A2E_API_BASE}/userImage2Video/allRecords`,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.code === 0) {
      return {
        success: true,
        data: response.data.data || []
      };
    } else {
      const errorMsg = response.data?.message || 'Unknown error';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('A2E Get All Records Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message || 'A2E API error'
    };
  }
}

/**
 * Видаляє задачу
 * 
 * @param {string} taskId - ID задачі
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteTask(taskId) {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN не налаштовано');
    }

    const response = await axios.delete(
      `${A2E_API_BASE}/userImage2Video/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.code === 0) {
      return {
        success: true
      };
    } else {
      const errorMsg = response.data?.message || 'Unknown error';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('A2E Delete Task Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message || 'A2E API error'
    };
  }
}

// ==================== TEXT-TO-IMAGE ====================

/**
 * Створює задачу генерації зображення з тексту через A2E API
 *
 * @param {Object} options - Параметри генерації
 * @param {string} options.prompt - Текстовий промпт
 * @param {number} [options.width=1024] - Ширина зображення
 * @param {number} [options.height=1024] - Висота зображення
 * @param {string} [options.modelType='a2e'] - Тип моделі (a2e, seedream)
 * @param {string[]} [options.inputImages] - URL референсних зображень (макс. 2)
 * @param {string} [options.aspectRatio] - Aspect ratio (для seedream)
 * @param {number} [options.maxImages=1] - Кількість зображень
 * @returns {Promise<{success: boolean, taskId?: string, error?: string}>}
 */
async function startText2ImageTask(options = {}) {
  try {
    const {
      prompt,
      width = 1024,
      height = 1024,
      modelType = 'a2e',
      inputImages = [],
      aspectRatio,
      maxImages = 1
    } = options;

    if (!prompt) {
      throw new Error('prompt є обов\'язковим параметром');
    }

    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN не налаштовано');
    }

    const requestBody = {
      name: `A2E_IMG_${Date.now()}`,
      prompt: prompt,
      width: width,
      height: height,
      model_type: modelType,
      max_images: maxImages
    };

    if (inputImages && inputImages.length > 0) {
      requestBody.input_images = inputImages.slice(0, 2);
    }

    if (aspectRatio) {
      requestBody.aspect_ratio = aspectRatio;
    }

    console.log(`🖼️ A2E Text2Image: Starting task:`, {
      modelType,
      width,
      height,
      hasRefs: inputImages.length,
      prompt: prompt.substring(0, 50)
    });

    const response = await axios.post(
      `${A2E_API_BASE}/userText2Image/start`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (response.data && response.data.code === 0) {
      const taskId = response.data.data?._id || response.data.data?.taskId || response.data.data?.id;
      console.log(`✅ A2E Text2Image task created: ${taskId}`);
      return {
        success: true,
        taskId: taskId
      };
    } else {
      const errorMsg = response.data?.message || 'Unknown error';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('A2E Text2Image API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message || 'A2E API error'
    };
  }
}

/**
 * Отримує інформацію про задачу text2image
 *
 * @param {string} taskId - ID задачі
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
async function getText2ImageTaskDetails(taskId) {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN не налаштовано');
    }

    const response = await axios.get(
      `${A2E_API_BASE}/userText2Image/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.code === 0) {
      return {
        success: true,
        data: response.data.data
      };
    } else {
      const errorMsg = response.data?.message || 'Unknown error';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('A2E Text2Image Get Task Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message || 'A2E API error'
    };
  }
}

module.exports = {
  startImageToVideoTask,
  startText2ImageTask,
  getTaskDetails,
  getText2ImageTaskDetails,
  getAllRecords,
  deleteTask,
  isA2EEnabled: !!A2E_API_TOKEN
};
