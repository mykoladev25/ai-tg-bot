const axios = require('axios');

const REPLICATE_API = 'https://api.replicate.com/v1';
const Replicate = require('replicate');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});


async function sendTelegramMessage(chatId, message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Telegram message error:', error.message);
  }
}

/**
 * Генерація зображення через FLUX
 */
async function generateWithFlux(prompt) {
  try {
    console.log('Starting FLUX generation:', prompt);

    const response = await axios.post(
      `${REPLICATE_API}/predictions`,
      {
        version: 'black-forest-labs/flux-1.1-pro',
        input: {
          prompt: prompt,
          aspect_ratio: '1:1',
          output_format: 'png',
          output_quality: 90,
          safety_tolerance: 2
        }
      },
      {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'wait'
        }
      }
    );

    const predictionId = response.data.id;
    console.log('FLUX prediction created:', predictionId);

    // Polling для результату
    let result = null;
    let attempts = 0;
    const maxAttempts = 60;

    while (!result && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const statusResponse = await axios.get(
        `${REPLICATE_API}/predictions/${predictionId}`,
        {
          headers: {
            'Authorization': `Token ${process.env.REPLICATE_API_KEY}`
          }
        }
      );

      console.log(`FLUX attempt ${attempts + 1}: ${statusResponse.data.status}`);

      if (statusResponse.data.status === 'succeeded') {
        result = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'failed') {
        throw new Error(statusResponse.data.error || 'Generation failed');
      }

      attempts++;
    }

    if (!result) {
      throw new Error('Timeout waiting for FLUX generation');
    }

    return {
      success: true,
      imageUrl: Array.isArray(result.output) ? result.output[0] : result.output
    };

  } catch (error) {
    console.error('FLUX API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.detail || error.message
    };
  }
}

/**
 * Генерація відео через Kling
 */
async function generateVideoWithKling(prompt, imageUrl = null) {
  try {
    console.log('Starting Kling video generation:', prompt);

    const input = {
      prompt: prompt,
      duration: 5,
      aspect_ratio: '16:9'
    };

    if (imageUrl) {
      input.image = imageUrl;
      input.mode = 'image-to-video';
    }

    const response = await axios.post(
      `${REPLICATE_API}/predictions`,
      {
        version: 'minimax/video-01',
        input: input
      },
      {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const predictionId = response.data.id;
    console.log('Kling prediction created:', predictionId);

    // Polling (відео генерується довше)
    let result = null;
    let attempts = 0;
    const maxAttempts = 180;

    while (!result && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const statusResponse = await axios.get(
        `${REPLICATE_API}/predictions/${predictionId}`,
        {
          headers: {
            'Authorization': `Token ${process.env.REPLICATE_API_KEY}`
          }
        }
      );

      console.log(`Kling attempt ${attempts + 1}: ${statusResponse.data.status}`);

      if (statusResponse.data.status === 'succeeded') {
        result = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'failed') {
        throw new Error(statusResponse.data.error || 'Video generation failed');
      }

      attempts++;
    }

    if (!result) {
      throw new Error('Timeout waiting for Kling video generation');
    }

    return {
      success: true,
      videoUrl: Array.isArray(result.output) ? result.output[0] : result.output
    };

  } catch (error) {
    console.error('Kling API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.detail || error.message
    };
  }
}

/**
 * Генерація відео через Runway Gen-4 Aleph (Replicate)
 */
async function generateVideoWithRunway(prompt, imageUrl = null) {
  try {
    console.log('Starting Runway Gen-4 video generation via Replicate:', prompt);

    const input = {
      prompt_text: prompt,
      seconds: 5
    };

    if (imageUrl) {
      input.prompt_image = imageUrl;
    }

    const output = await replicate.run(
        "runwayml/gen4-aleph",
        { input }
    );

    // Output - URL відео
    const videoUrl = Array.isArray(output) ? output[0] : output;

    return {
      success: true,
      videoUrl: videoUrl
    };

  } catch (error) {
    console.error('Runway Gen-4 API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Stable Diffusion
 */
async function generateWithStableDiffusion(prompt) {
  try {
    console.log('Starting Stable Diffusion generation:', prompt);

    const response = await axios.post(
      `${REPLICATE_API}/predictions`,
      {
        version: 'stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b',
        input: {
          prompt: prompt,
          negative_prompt: 'ugly, blurry, low quality',
          width: 1024,
          height: 1024
        }
      },
      {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'wait'
        }
      }
    );

    const predictionId = response.data.id;

    let result = null;
    let attempts = 0;

    while (!result && attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const statusResponse = await axios.get(
        `${REPLICATE_API}/predictions/${predictionId}`,
        {
          headers: {
            'Authorization': `Token ${process.env.REPLICATE_API_KEY}`
          }
        }
      );

      if (statusResponse.data.status === 'succeeded') {
        result = statusResponse.data;
        break;
      } else if (statusResponse.data.status === 'failed') {
        throw new Error('Generation failed');
      }

      attempts++;
    }

    return {
      success: true,
      imageUrl: Array.isArray(result.output) ? result.output[0] : result.output
    };

  } catch (error) {
    console.error('Stable Diffusion Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Генерувати зображення через Nano Banana Pro
 */
/**
 * Генерувати зображення через Nano Banana Pro
 */
async function generateWithNanoBanana(prompt) {
  try {
    console.log('Generating with Nano Banana Pro:', prompt);

    const input = {
      prompt: prompt,
      aspect_ratio: "1:1",
      num_outputs: 1,
      output_format: "webp",
      output_quality: 90,
      num_inference_steps: 4
    };

    const output = await replicate.run("google/nano-banana-pro", { input });

    // Output - масив URL-ів
    const imageUrl = Array.isArray(output) ? output[0] : output;

    return {
      success: true,
      imageUrl: imageUrl
    };

  } catch (error) {
    console.error('Nano Banana Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Генерувати зображення через Seedream 4.5
 */
async function generateWithSeedream(prompt) {
  try {
    console.log('Generating with Seedream 4.5:', prompt);

    const input = {
      prompt: prompt,
      guidance: 5,
      num_outputs: 1,
      aspect_ratio: "1:1",
      output_format: "webp",
      output_quality: 90,
      num_inference_steps: 50
    };

    const output = await replicate.run("bytedance/seedream-4", { input });

    // Output - масив URL-ів
    const imageUrl = Array.isArray(output) ? output[0] : output;

    return {
      success: true,
      imageUrl: imageUrl
    };

  } catch (error) {
    console.error('Seedream Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Покращення зображення через Clarity Upscaler
 */
async function generateWithClarityUpscaler(imageUrl, prompt = '') {
  try {
    console.log('Upscaling with Clarity:', imageUrl);

    const input = {
      image: imageUrl,
      prompt: prompt || 'masterpiece, best quality, highres, extremely detailed',
      negative_prompt: 'worst quality, low quality, normal quality',
      scale_factor: 2,
      dynamic: 6,
      creativity: 0.35,
      resemblance: 0.6,
      tiling_width: 112,
      tiling_height: 144,
      sd_model: 'juggernaut_reborn.safetensors [338b85bc4f]',
      scheduler: 'DPM++ 3M SDE Karras',
      num_inference_steps: 18,
      downscaling: false,
      downscaling_resolution: 768,
      lora_links: '',
      custom_sd_model: '',
      sharpen: 0,
      seed: -1,
      output_format: 'png'
    };

    const output = await replicate.run(
        "philz1337x/clarity-upscaler:dfad41707589d68ecdccd1dfa600d55a208f9310748e44bfe35b4a6291453d5e",
        { input }
    );

    // Output - URL зображення
    const imageOutputUrl = output[0];

    return {
      success: true,
      imageUrl: imageOutputUrl
    };

  } catch (error) {
    console.error('Clarity Upscaler Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Генерувати зображення через Ideogram v3 Turbo
 */
async function generateWithIdeogram(prompt) {
  try {
    console.log('Generating with Ideogram v3 Turbo:', prompt);

    const input = {
      prompt: prompt,
      aspect_ratio: "1:1",
      magic_prompt_option: "Auto"
    };

    const output = await replicate.run(
        "ideogram-ai/ideogram-v3-turbo",
        { input }
    );

    // Output - URL зображення
    const imageUrl = Array.isArray(output) ? output[0] : output;

    return {
      success: true,
      imageUrl: imageUrl
    };

  } catch (error) {
    console.error('Ideogram Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Генерувати аудіо через Suno AI Bark
 */
async function generateWithSuno(text, voice = 'v2/en_speaker_6') {
  try {
    console.log('Generating audio with Suno AI Bark:', text);

    const input = {
      prompt: text,
      text_temp: 0.7,
      waveform_temp: 0.7,
      history_prompt: voice,
      output_full: false
    };

    const output = await replicate.run(
        "suno-ai/bark:b76242b40d67c76ab6742e987628a2a9ac019e11d56ab96c4e91ce03b79b2787",
        { input }
    );

    // Output - URL аудіо файлу
    const audioUrl = output?.audio || output;

    return {
      success: true,
      audioUrl: audioUrl
    };

  } catch (error) {
    console.error('Suno AI Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Генерація відео через Runway Gen-4 Turbo (Replicate)
 */
async function generateVideoWithRunwayTurbo(prompt, imageUrl = null) {
  try {
    console.log('Starting Runway Gen-4 Turbo video generation via Replicate:', prompt);

    const input = {
      prompt_text: prompt,
      seconds: 5
    };

    if (imageUrl) {
      input.prompt_image = imageUrl;
    }

    const output = await replicate.run(
        "runwayml/gen4-turbo",
        { input }
    );

    // Output - URL відео
    const videoUrl = Array.isArray(output) ? output[0] : output;

    return {
      success: true,
      videoUrl: videoUrl
    };

  } catch (error) {
    console.error('Runway Gen-4 Turbo API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


module.exports = {
  generateWithFlux,
  generateWithStableDiffusion,
  generateWithNanoBanana,
  generateWithSeedream,
  generateWithClarityUpscaler,
  generateWithIdeogram,
  generateWithSuno,
  generateVideoWithRunwayTurbo,
  generateVideoWithKling,
  generateVideoWithRunway
};
