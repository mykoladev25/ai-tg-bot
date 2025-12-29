const axios = require('axios');

const REPLICATE_API = 'https://api.replicate.com/v1';
const Replicate = require('replicate');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});

// ==================== HELPER FUNCTIONS ====================

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
 * Конвертувати URL зображення в base64 data URI
 */
async function convertImageToBase64(imageUrl) {
  try {
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
    return `data:${contentType};base64,${imageBase64}`;
  } catch (error) {
    console.error('Image conversion error:', error.message);
    throw error;
  }
}

/**
 * Нормалізувати image input (підтримка до 14 зображень)
 */
function normalizeImageInput(imageInput, maxImages = 14) {
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

/**
 * Polling для очікування результату від Replicate API
 */
async function pollPrediction(predictionId, maxAttempts = 60, interval = 2000, modelName = 'Model') {
  let result = null;
  let attempts = 0;

  while (!result && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, interval));

    const statusResponse = await axios.get(
      `${REPLICATE_API}/predictions/${predictionId}`,
      {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_KEY}`
        }
      }
    );

    console.log(`${modelName} attempt ${attempts + 1}: ${statusResponse.data.status}`);

    if (statusResponse.data.status === 'succeeded') {
      result = statusResponse.data;
      break;
    } else if (statusResponse.data.status === 'failed') {
      throw new Error(statusResponse.data.error || 'Generation failed');
    }

    attempts++;
  }

  if (!result) {
    throw new Error(`Timeout waiting for ${modelName} generation`);
  }

  return result;
}

// ==================== IMAGE GENERATION ====================

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

    const result = await pollPrediction(predictionId, 60, 2000, 'FLUX');

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
 * Stable Diffusion 3.5 Large (text2img + img2img)
 */
async function generateWithStableDiffusion(prompt, imageUrl = null, strength = 0.8) {
  try {
    console.log('Starting Stable Diffusion 3.5 generation:', prompt);

    const input = {
      prompt: prompt,
      negative_prompt: 'ugly, blurry, low quality, distorted',
      aspect_ratio: '1:1',
      output_format: 'png',
      output_quality: 90
    };

    if (imageUrl) {
      input.image = await convertImageToBase64(imageUrl);
      input.strength = strength;
      console.log('Using image input (base64), strength:', strength);
    }

    const response = await axios.post(
      `${REPLICATE_API}/predictions`,
      {
        version: 'stability-ai/stable-diffusion-3.5-large',
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
    console.log('Stable Diffusion prediction created:', predictionId);

    const result = await pollPrediction(predictionId, 60, 2000, 'Stable Diffusion');

    return {
      success: true,
      imageUrl: Array.isArray(result.output) ? result.output[0] : result.output
    };

  } catch (error) {
    console.error('Stable Diffusion Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.detail || error.message
    };
  }
}

/**
 * Генерувати зображення через Nano Banana Pro (підтримка до 14 зображень)
 */
async function generateWithNanoBanana(prompt, imageInput = null, resolution = "2K") {
  try {
    console.log('Generating with Nano Banana Pro:', prompt);

    const input = {
      prompt: prompt,
      resolution: resolution,
      image_input: normalizeImageInput(imageInput, 14),
      aspect_ratio: "1:1",
      output_format: "png",
      safety_filter_level: "block_only_high"
    };

    if (input.image_input.length > 0) {
      console.log(`Using ${input.image_input.length} image(s) as input`);
    }

    const output = await replicate.run("google/nano-banana-pro", { input });

    return {
      success: true,
      imageUrl: Array.isArray(output) ? output[0] : output
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
 * Генерувати зображення через Seedream 4.5 (підтримка до 14 зображень)
 */
async function generateWithSeedream(prompt, imageInput = null, size = "4K") {
  try {
    console.log('Generating with Seedream 4.5:', prompt);

    const input = {
      size: size,
      width: 2048,
      height: 2048,
      prompt: prompt,
      max_images: 1,
      image_input: normalizeImageInput(imageInput, 14),
      aspect_ratio: "16:9",
      sequential_image_generation: "disabled"
    };

    if (input.image_input.length > 0) {
      console.log(`Using ${input.image_input.length} image(s) as input`);
    }

    const output = await replicate.run("bytedance/seedream-4.5", { input });

    return {
      success: true,
      imageUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Seedream Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function generateWithIdeogram(prompt, imageInput = null, imageWeight = 0.5) {
  try {
    console.log('Generating with Ideogram v3 Turbo:', prompt);

    const input = {
      prompt: prompt,
      aspect_ratio: "1:1",
      magic_prompt_option: "Auto"
    };

    // ✅ Ideogram приймає тільки ОДНЕ зображення в base64 data URI
    if (imageInput) {
      const imageUrl = Array.isArray(imageInput) ? imageInput[0] : imageInput;
      input.image_file = await convertImageToBase64(imageUrl);
      input.image_weight = imageWeight; // 0.0-1.0 (default 0.5)
      console.log(`Using 1 image as input (base64), weight: ${imageWeight}`);
    }

    const output = await replicate.run("ideogram-ai/ideogram-v3-turbo", { input });

    return {
      success: true,
      imageUrl: Array.isArray(output) ? output[0] : output
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

    return {
      success: true,
      imageUrl: output[0]
    };

  } catch (error) {
    console.error('Clarity Upscaler Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== VIDEO GENERATION ====================

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
        version: 'kwaivgi/kling-v2.5-turbo-pro',
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

    const result = await pollPrediction(predictionId, 180, 5000, 'Kling');

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
 * Генерація відео через Runway Gen-4 Aleph
 */
async function generateVideoWithRunway(prompt, imageUrl = null) {
  try {
    console.log('Starting Runway Gen-4 video generation:', prompt);

    const input = {
      prompt_text: prompt,
      seconds: 5
    };

    if (imageUrl) {
      input.prompt_image = imageUrl;
    }

    const output = await replicate.run("runwayml/gen4-aleph", { input });

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
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
 * Генерація відео через Runway Gen-4 Turbo
 */
async function generateVideoWithRunwayTurbo(prompt, imageUrl = null) {
  try {
    console.log('Starting Runway Gen-4 Turbo video generation:', prompt);

    const input = {
      prompt: prompt,
      seconds: 5
    };

    if (imageUrl) {
      input.image = imageUrl;
    }

    const output = await replicate.run("runwayml/gen4-turbo", { input });

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Runway Gen-4 Turbo API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== AUDIO GENERATION ====================

/**
 * Генерувати аудіо через Suno AI Bark
 */
async function generateWithSuno(text, voice = 'announcer') {
  try {
    console.log('Generating audio with Suno AI Bark:', text);

    const validVoices = [
      "announcer",
      "en_speaker_0", "en_speaker_1", "en_speaker_2",
      "ru_speaker_0", "ru_speaker_1",
      "pl_speaker_0", "pl_speaker_1"
    ];

    const selectedVoice = validVoices.includes(voice) ? voice : "announcer";

    const input = {
      prompt: text,
      text_temp: 0.7,
      waveform_temp: 0.7,
      history_prompt: selectedVoice,
      output_full: false
    };

    const output = await replicate.run(
      "suno-ai/bark:b76242b40d67c76ab6742e987628a2a9ac019e11d56ab96c4e91ce03b79b2787",
      { input }
    );

    return {
      success: true,
      audioUrl: output?.audio || output
    };

  } catch (error) {
    console.error('Suno AI Error:', error);
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