const axios = require('axios');

const MIDJOURNEY_API = process.env.MIDJOURNEY_API_URL;
const API_KEY = process.env.MIDJOURNEY_API_KEY;

/**
 * Генерація зображення через Midjourney
 */
async function generateImage(prompt) {
  try {
    console.log('Starting Midjourney generation:', prompt);

    // Створюємо задачу
    const response = await axios.post(
      `${MIDJOURNEY_API}/imagine`,
      {
        prompt: prompt,
        process_mode: 'fast'
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const taskId = response.data.task_id;
    console.log('IMAGINE RESPONSE:', JSON.stringify(response.data, null, 2));

    console.log('Task created:', taskId);

    // Чекаємо результат (polling)
    let result = null;
    let attempts = 0;
    const maxAttempts = 60; // 5 хвилин максимум

    while (!result && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Чекаємо 5 секунд
      
      const statusResponse = await axios.get(
        `${MIDJOURNEY_API}/result/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`
          }
        }
      );

      console.log(`Attempt ${attempts + 1}: Status = ${statusResponse.data.status}`);

      if (statusResponse.data.status === 'completed') {
        result = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'failed') {
        throw new Error('Midjourney generation failed');
      }

      attempts++;
    }

    if (!result) {
      throw new Error('Timeout waiting for generation');
    }

    return {
      success: true,
      imageUrl: result.image_url,
      taskId: taskId,
      thumbnails: result.thumbnails || []
    };

  } catch (error) {
    console.error('Midjourney API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

/**
 * Upscale зображення
 */
async function upscaleImage(taskId, index) {
  try {
    const response = await axios.post(
      `${MIDJOURNEY_API}/upscale`,
      {
        task_id: taskId,
        index: index
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Чекаємо результат
    const upscaleTaskId = response.data.task_id;
    let result = null;
    let attempts = 0;

    while (!result && attempts < 40) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const statusResponse = await axios.get(
        `${MIDJOURNEY_API}/result/${upscaleTaskId}`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`
          }
        }
      );

      if (statusResponse.data.status === 'completed') {
        result = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'failed') {
        throw new Error('Upscale failed');
      }

      attempts++;
    }

    return {
      success: true,
      imageUrl: result.image_url
    };

  } catch (error) {
    console.error('Midjourney Upscale Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Варіації зображення
 */
async function variateImage(taskId, index) {
  try {
    const response = await axios.post(
      `${MIDJOURNEY_API}/variation`,
      {
        task_id: taskId,
        index: index
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const variationTaskId = response.data.task_id;
    let result = null;
    let attempts = 0;

    while (!result && attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const statusResponse = await axios.get(
        `${MIDJOURNEY_API}/result/${variationTaskId}`,
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`
          }
        }
      );

      if (statusResponse.data.status === 'completed') {
        result = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'failed') {
        throw new Error('Variation failed');
      }

      attempts++;
    }

    return {
      success: true,
      imageUrl: result.image_url,
      taskId: variationTaskId
    };

  } catch (error) {
    console.error('Midjourney Variation Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  generateImage,
  upscaleImage,
  variateImage
};
