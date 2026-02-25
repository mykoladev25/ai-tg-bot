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

    // Визначаємо req_key (стиль) на основі modelType
    // high_aes_general_v21_L = General Style, high_aes = Manga Style
    const reqKey = modelType === 'manga' ? 'high_aes' : 'high_aes_general_v21_L';

    // ===== Формуємо body згідно з A2E API документацією =====
    // Обов'язкові поля: name, prompt, req_key, width, height
    const requestBody = {
      name: new Date().toISOString().replace('T', ' ').substring(0, 19),
      prompt: prompt,
      req_key: reqKey,
      width: width,
      height: height
    };

    // Додаткові поля якщо є
    if (inputImages && inputImages.length > 0) {
      requestBody.input_images = inputImages.slice(0, 2);
    }

    console.log(`🖼️ A2E Text2Image: Starting task:`, {
      reqKey,
      width,
      height,
      hasRefs: inputImages.length,
      prompt: prompt.substring(0, 80)
    });

    // ===== Відправляємо запит =====
    // Endpoint: POST /api/v1/userText2image/start (lowercase 'i' в 'image')
    const response = await axios.post(
      `${A2E_API_BASE}/userText2image/start`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000 // 2 хвилини — API може генерувати синхронно
      }
    );

    console.log(`📥 A2E Text2Image response: code=${response.data?.code}, keys=${response.data?.data ? Object.keys(response.data.data).join(',') : 'null'}`);

    if (response.data && response.data.code === 0) {
      const respData = response.data.data;

      // ===== A2E API повертає результат СИНХРОННО =====
      // respData містить: _id, image_urls[], current_status, prompt, width, height, ...
      const taskId = respData?._id || respData?.taskId || respData?.id;

      // Перевіряємо чи зображення вже готове (синхронна відповідь)
      if (respData?.image_urls && Array.isArray(respData.image_urls) && respData.image_urls.length > 0) {
        const imageUrl = respData.image_urls[0];
        console.log(`✅ A2E Text2Image: Got SYNC result! taskId=${taskId}, status=${respData.current_status}, image_urls=${respData.image_urls.length}, url=${imageUrl.substring(0, 100)}`);
        return {
          success: true,
          taskId: taskId || '__inline__',
          imageUrl: imageUrl,
          allImageUrls: respData.image_urls
        };
      }

      // Якщо current_status === 'completed' але image_urls відсутній
      if (respData?.current_status === 'completed' || respData?.current_status === 'success') {
        // Спробуємо знайти URL
        const inlineUrl = respData?.image_url || respData?.result_url || respData?.output_url;
        if (inlineUrl) {
          console.log(`✅ A2E Text2Image: Got inline URL from alt field: ${inlineUrl.substring(0, 100)}`);
          return {
            success: true,
            taskId: taskId || '__inline__',
            imageUrl: inlineUrl
          };
        }
      }

      // Якщо результат ще не готовий — повертаємо taskId для polling
      if (taskId) {
        console.log(`✅ A2E Text2Image task created (async): ${taskId}, status=${respData?.current_status || 'unknown'}`);
        return {
          success: true,
          taskId: taskId
        };
      }

      // Крайній випадок: data є об'єктом але без _id і без image_urls
      console.error(`❌ A2E Text2Image: Response has no taskId and no image_urls. Full data: ${JSON.stringify(respData).substring(0, 500)}`);

      // Спробувати через records list
      try {
        await new Promise(r => setTimeout(r, 3000));
        const recordsResp = await axios.get(
          `${A2E_API_BASE}/userText2image/records`,
          {
            headers: {
              'Authorization': `Bearer ${A2E_API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );
        const records = recordsResp.data?.data;
        if (Array.isArray(records) && records.length > 0) {
          const latest = records[0];
          const latestId = latest?._id || latest?.id;
          // Перевіряємо чи є image_urls у запису
          if (latest?.image_urls && latest.image_urls.length > 0) {
            console.log(`📋 A2E Text2Image: Found completed task via records: ${latestId}, url=${latest.image_urls[0].substring(0, 100)}`);
            return {
              success: true,
              taskId: latestId || '__inline__',
              imageUrl: latest.image_urls[0],
              allImageUrls: latest.image_urls
            };
          }
          if (latestId) {
            console.log(`📋 A2E Text2Image: Found task via records: ${latestId}, status=${latest?.current_status}`);
            return {
              success: true,
              taskId: latestId
            };
          }
        }
      } catch (recordsErr) {
        console.warn(`⚠️ A2E Text2Image: Failed to get records: ${recordsErr.message}`);
      }

      throw new Error('A2E API did not return a task ID or image URL');

    } else {
      console.error(`❌ A2E Text2Image unexpected response:`, JSON.stringify(response.data, null, 2));
      const errorMsg = response.data?.message || response.data?.msg || 'Unknown error';
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

    // A2E API uses lowercase 'i' in 'image': /userText2image/
    const response = await axios.get(
      `${A2E_API_BASE}/userText2image/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.code === 0) {
      const data = response.data.data;
      console.log(`📥 A2E Text2Image details: taskId=${taskId}, status=${data?.current_status}, hasImageUrls=${!!(data?.image_urls?.length)}`);
      return {
        success: true,
        data: data
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
