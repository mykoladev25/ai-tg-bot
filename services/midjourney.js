const axios = require('axios');

const KIE_API_BASE = 'https://api.kie.ai';
const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL
  || (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/webhook/kie-ai` : null);

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
 * - Upscale: included
 * - Vary: included
 */

/**
 * Generate media with Midjourney through KIE.AI.
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
    };

    if (WEBHOOK_URL) {
      payload.callBackUrl = WEBHOOK_URL;
    }

    if (fileUrls && fileUrls.length > 0) {
      payload.fileUrls = fileUrls;
    } else if (fileUrl) {
      payload.fileUrl = fileUrl;
    }

    if (taskType === 'mj_omni_reference') {
      payload.ow = ow;
    }

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
 * Get Midjourney task status
 * @param {string} taskId - Task ID
 * @returns {Promise<Object>} Status and results
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
 * Upscale image (free)
 * @param {string} taskId - Original task ID
 * @param {number} imageIndex - Image index (1-4)
 * @param {string} [waterMark] - Watermark
 * @returns {Promise<Object>} Result with new taskId
 */
async function upscaleImage(taskId, imageIndex, waterMark = '') {
  try {
    console.log('🔍 Midjourney: Starting upscale', { taskId, imageIndex });

    const response = await axios.post(
      `${KIE_API_BASE}/api/v1/mj/generateUpscale`,
      {
        taskId,
        imageIndex: imageIndex - 1,  // API uses a 0-based index
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
 * Create image variations (free)
 * @param {string} taskId - Original task ID
 * @param {number} imageIndex - Image index (1-4)
 * @param {string} [waterMark] - Watermark
 * @returns {Promise<Object>} Result with new taskId
 */
async function variateImage(taskId, imageIndex, waterMark = '') {
  try {
    console.log('🎨 Midjourney: Starting vary', { taskId, imageIndex });

    const response = await axios.post(
      `${KIE_API_BASE}/api/v1/mj/generateVary`,
      {
        taskId,
        imageIndex,  // API uses a 1-based index for vary
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
 * Wait for task completion (polling)
 * @param {string} taskId - Task ID
 * @param {number} [maxAttempts=60] - Maximum attempts
 * @param {number} [interval=5000] - Interval between attempts (ms)
 * @returns {Promise<Object>} Task result
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

  console.error('⏱️ Midjourney task timeout after', maxAttempts, 'attempts');
  return {
    success: false,
    error: `Timeout waiting for generation (waited ${(maxAttempts * interval) / 1000}s)`
  };
}

module.exports = {
  generateImage,
  getTaskStatus,
  upscaleImage,
  variateImage,
  waitForCompletion
};
