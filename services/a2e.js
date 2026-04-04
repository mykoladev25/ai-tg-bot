const axios = require('axios');

const A2E_API_BASE = 'https://video.a2e.ai/api/v1';
const A2E_API_TOKEN = process.env.A2E_API_TOKEN;

if (!A2E_API_TOKEN) {
  console.warn('⚠️ A2E_API_TOKEN not set in environment variables');
}


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
      throw new Error('imageUrl is required');
    }

    if (!prompt) {
      throw new Error('prompt is required');
    }

    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN is not configured');
    }

    const validVideoTimes = [5, 10, 15, 20];
    if (!validVideoTimes.includes(videoTime)) {
      throw new Error(`videoTime must be one of: ${validVideoTimes.join(', ')}`);
    }

    if (modelType === 'FLF2V' && !endImageUrl) {
      throw new Error('endImageUrl is required for the FLF2V model');
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


async function getTaskDetails(taskId) {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN is not configured');
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


async function getAllRecords() {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN is not configured');
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


async function deleteTask(taskId) {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN is not configured');
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
      throw new Error('prompt is required');
    }

    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN is not configured');
    }

    // high_aes_general_v21_L = General Style, high_aes = Manga Style
    const reqKey = modelType === 'manga' ? 'high_aes' : 'high_aes_general_v21_L';

    const requestBody = {
      name: new Date().toISOString().replace('T', ' ').substring(0, 19),
      prompt: prompt,
      req_key: reqKey,
      width: width,
      height: height
    };

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

    const response = await axios.post(
      `${A2E_API_BASE}/userText2image/start`,
      requestBody,
      {
        headers: {
          'Authorization': `Bearer ${A2E_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000 
      }
    );

    const rawData = response.data?.data;
    const isArray = Array.isArray(rawData);
    console.log(`📥 A2E Text2Image response: code=${response.data?.code}, dataIsArray=${isArray}, dataLength=${isArray ? rawData.length : 'N/A'}`);
    console.log(`📥 A2E Text2Image response FULL: ${JSON.stringify(response.data).substring(0, 1000)}`);

    if (response.data && response.data.code === 0) {
      const respData = isArray ? rawData[0] : rawData;

      if (!respData || (typeof respData === 'object' && Object.keys(respData).length === 0)) {
        console.error(`❌ A2E Text2Image: Empty response data. Raw: ${JSON.stringify(rawData).substring(0, 300)}`);
        throw new Error('A2E API returned empty data');
      }

      const taskId = respData._id || respData.taskId || respData.id;
      const status = respData.current_status || 'unknown';
      const imageUrls = respData.image_urls || [];
      console.log(`📥 A2E Text2Image parsed: _id=${taskId}, status=${status}, image_urls=${imageUrls.length}, keys=${Object.keys(respData).join(',')}`);

      if (imageUrls.length > 0 && imageUrls[0]) {
        const imageUrl = imageUrls[0];
        console.log(`✅ A2E Text2Image: Got SYNC result! taskId=${taskId}, status=${status}, urls=${imageUrls.length}, url=${imageUrl.substring(0, 100)}`);
        return {
          success: true,
          taskId: taskId || '__inline__',
          imageUrl: imageUrl,
          allImageUrls: imageUrls
        };
      }

      if (taskId) {
        console.log(`✅ A2E Text2Image task created: ${taskId}, status=${status} → needs polling`);
        return {
          success: true,
          taskId: taskId,
          needsPolling: true
        };
      }

      console.error(`❌ A2E Text2Image: No taskId and no image_urls. Full data: ${JSON.stringify(respData).substring(0, 500)}`);
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


async function getText2ImageTaskDetails(taskId) {
  try {
    if (!A2E_API_TOKEN) {
      throw new Error('A2E_API_TOKEN is not configured');
    }

    // ===== METHOD 1: GET /api/v1/userText2image/:taskId =====
    try {
      const response = await axios.get(
        `${A2E_API_BASE}/userText2image/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${A2E_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      if (response.data && response.data.code === 0) {
        const rawData = response.data.data;
        const data = Array.isArray(rawData) ? rawData[0] : rawData;
        console.log(`📥 A2E Text2Image details: taskId=${taskId}, status=${data?.current_status}, image_urls=${data?.image_urls?.length || 0}`);
        return {
          success: true,
          data: data
        };
      }
    } catch (e1) {
      const status = e1.response?.status;
      console.warn(`⚠️ A2E Text2Image GET /${taskId}: HTTP ${status || e1.message}`);
      // If 400/404 — try allRecords fallback
      if (status !== 400 && status !== 404 && status !== 405) {
        throw e1; // re-throw non-400 errors
      }
    }

    // ===== METHOD 2 (FALLBACK): GET allRecords and filter by _id =====
    try {
      console.log(`🔄 A2E Text2Image: Trying allRecords fallback for taskId=${taskId}...`);
      const response = await axios.get(
        `${A2E_API_BASE}/userText2image/allRecords`,
        {
          headers: {
            'Authorization': `Bearer ${A2E_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      if (response.data && response.data.code === 0) {
        const records = response.data.data || [];
        const recordsList = Array.isArray(records) ? records : [records];
        const task = recordsList.find(r => r._id === taskId || r.id === taskId || r.taskId === taskId);
        if (task) {
          console.log(`📥 A2E Text2Image allRecords: found taskId=${taskId}, status=${task.current_status}, image_urls=${task.image_urls?.length || 0}`);
          return {
            success: true,
            data: task
          };
        } else {
          console.warn(`⚠️ A2E Text2Image allRecords: taskId=${taskId} not found in ${recordsList.length} records`);
        }
      }
    } catch (e2) {
      console.warn(`⚠️ A2E Text2Image allRecords failed: ${e2.response?.status || e2.message}`);
    }

    return {
      success: false,
      error: `Task ${taskId} not found`
    };

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
