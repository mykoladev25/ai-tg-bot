const axios = require('axios');

const KIE_API_BASE = 'https://api.kie.ai/api/v1/jobs';
const KIE_API_KEY = process.env.KIE_AI_API_KEY;

async function removeSoraWatermark(videoUrl, uploadMethod = 's3') {
  try {
    if (!videoUrl.includes('sora.chatgpt.com')) {
      return {
        success: false,
        error: 'The video URL must come from sora.chatgpt.com'
      };
    }

    const response = await axios.post(
      `${KIE_API_BASE}/createTask`,
      {
        model: 'sora-watermark-remover',
        input: {
          video_url: videoUrl,
          upload_method: uploadMethod
        }
      },
      {
        headers: {
          Authorization: `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.code === 200 && response.data.data?.taskId) {
      return {
        success: true,
        taskId: response.data.data.taskId
      };
    }

    return {
      success: false,
      error: response.data.msg || 'Failed to create a watermark removal task'
    };
  } catch (error) {
    console.error('Sora watermark remover error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

async function checkTaskStatus(taskId) {
  try {
    const response = await axios.get(`${KIE_API_BASE}/recordInfo`, {
      params: { taskId },
      headers: {
        Authorization: `Bearer ${KIE_API_KEY}`
      }
    });

    if (response.data.code !== 200) {
      return {
        success: false,
        error: response.data.msg || 'Failed to check task status'
      };
    }

    const data = response.data.data;
    if (data.state === 'success' && data.resultJson) {
      const result = JSON.parse(data.resultJson);
      return {
        success: true,
        state: 'success',
        resultUrls: result.resultUrls || []
      };
    }

    if (data.state === 'fail') {
      return {
        success: false,
        state: 'fail',
        error: data.failMsg || 'Watermark removal failed'
      };
    }

    return {
      success: true,
      state: 'waiting'
    };
  } catch (error) {
    console.error('Sora watermark status error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.msg || error.message
    };
  }
}

async function removeSoraWatermarkWithWait(videoUrl, uploadMethod = 's3', maxRetries = 60, retryDelay = 5000) {
  const createResult = await removeSoraWatermark(videoUrl, uploadMethod);
  if (!createResult.success) {
    return createResult;
  }

  let retries = 0;
  while (retries < maxRetries) {
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
    const status = await checkTaskStatus(createResult.taskId);

    if (status.state === 'success') {
      return {
        success: true,
        taskId: createResult.taskId,
        videoUrl: status.resultUrls?.[0]
      };
    }

    if (status.state === 'fail') {
      return {
        success: false,
        error: status.error
      };
    }

    retries += 1;
  }

  return {
    success: false,
    error: 'Timed out while waiting for watermark removal'
  };
}

module.exports = {
  checkTaskStatus,
  removeSoraWatermark,
  removeSoraWatermarkWithWait
};
