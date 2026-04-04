const axios = require('axios');
const { getTelegramBotToken } = require('../utils/telegramFiles');

const REPLICATE_API = 'https://api.replicate.com/v1';
const Replicate = require('replicate');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});

// ==================== HELPER FUNCTIONS ====================

async function sendTelegramMessage(chatId, message) {
  const botToken = getTelegramBotToken();
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
 * Convert an image URL to a base64 data URI.
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
 * Normalize image input and enforce the provider limit.
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
 * Poll Replicate until a prediction completes.
 */
async function pollPrediction(predictionId, maxAttempts = 400, interval = 3000, modelName = 'Model') {
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

  // Perform one final status check before returning a timeout error.
  if (!result) {
    try {
      const last = await axios.get(`${REPLICATE_API}/predictions/${predictionId}`, {
        headers: { 'Authorization': `Token ${process.env.REPLICATE_API_KEY}` }
      });
      if (last.data?.status === 'succeeded') {
        console.log(`📊 ${modelName} got result on final check`);
        return last.data;
      }
    } catch (e) { /* ignore final status errors */ }
    throw new Error(`Timeout waiting for ${modelName} generation`);
  }

  return result;
}

// ==================== IMAGE GENERATION ====================

/**
 * Generate an image with FLUX.
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

    const result = await pollPrediction(predictionId, 400, 3000, 'FLUX');

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
 * Stable Diffusion 3.5 Large (text-to-image + image-to-image).
 */
async function generateWithStableDiffusion(prompt, imageUrl = null, strength = 0.8, aspectRatio = '1:1') {
  try {
    console.log('Starting Stable Diffusion 3.5 generation:', prompt);

    const input = {
      prompt: prompt,
      negative_prompt: 'ugly, blurry, low quality, distorted',
      output_format: 'png',
      output_quality: 90
    };

    if (imageUrl) {
      const imageRef = Array.isArray(imageUrl) ? imageUrl[0] : imageUrl;
      input.image = imageRef;
      input.prompt_strength = strength;
      console.log('Using image input (url), prompt_strength:', strength);
    } else {
      input.aspect_ratio = aspectRatio;
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

    const result = await pollPrediction(predictionId, 400, 3000, 'Stable Diffusion');

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
 * Generate an image with Nano Banana Pro.
 */
async function generateWithNanoBanana(prompt, imageInput = null, resolution = "2K", aspectRatio = "match_input_image") {
  try {
    console.log('Generating with Nano Banana Pro:', prompt, `aspect_ratio: ${aspectRatio}`);

    const input = {
      prompt: prompt,
      resolution: resolution,
      image_input: normalizeImageInput(imageInput, 14),
      aspect_ratio: aspectRatio,
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


async function generateWithNanoBananaBase(prompt, imageInput = null, aspectRatio = "match_input_image", outputFormat = "jpg") {
  try {
    console.log('Generating with Nano Banana:', prompt, `aspect_ratio: ${aspectRatio}`);

    const input = {
      prompt: prompt,
      image_input: normalizeImageInput(imageInput, 3),
      aspect_ratio: aspectRatio,
      output_format: outputFormat
    };

    if (input.image_input.length > 0) {
      console.log(`Using ${input.image_input.length} image(s) as input`);
    }

    const output = await replicate.run("google/nano-banana", { input });

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


async function generateWithSeedream(prompt, imageInput = null, size = "4K", aspectRatio = "match_input_image") {
  try {
    console.log('Generating with Seedream 4.5:', prompt, `aspect_ratio: ${aspectRatio}`);

    const input = {
      size: size,
      width: 2048,
      height: 2048,
      prompt: prompt,
      max_images: 1,
      image_input: normalizeImageInput(imageInput, 14),
      aspect_ratio: aspectRatio,
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

async function generateWithIdeogram(prompt, imageInput = null, imageWeight = 0.5, aspectRatio = "match_input_image") {
  try {
    console.log('Generating with Ideogram v3 Turbo:', prompt, `aspect_ratio: ${aspectRatio}`);

    const input = {
      prompt: prompt,
      aspect_ratio: aspectRatio,
      magic_prompt_option: "Auto"
    };

    if (imageInput) {
      const imageUrl = Array.isArray(imageInput) ? imageInput[0] : imageInput;
      if (!imageUrl) {
        console.warn('Ideogram: imageInput provided but empty/invalid, skipping style_reference_images.');
      } else {
        input.style_reference_images = [imageUrl];
        input.image_weight = imageWeight; // 0.0-1.0 (default 0.5)
        console.log(`Using 1 image as style_reference_images (url), weight: ${imageWeight}`);
      }
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

/**
 * Upscale image via Recraft Crisp Upscale
 */
async function generateWithRecraftCrispUpscale(imageUrl) {
  try {
    console.log('Upscaling with Recraft Crisp:', imageUrl);

    const input = {
      image: imageUrl
    };

    const output = await replicate.run(
      'recraft-ai/recraft-crisp-upscale',
      { input }
    );

    return {
      success: true,
      imageUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Recraft Crisp Upscale Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== VIDEO GENERATION ====================


async function generateVideoWithKling(prompt, startImage = null, endImage = null, duration = 5, aspectRatio = '16:9') {
  try {
    console.log('Starting Kling v2.5 Turbo Pro video generation:', {
      prompt: prompt.substring(0, 100),
      duration,
      aspectRatio,
      hasStartImage: !!startImage,
      hasEndImage: !!endImage
    });

    const input = {
      prompt: prompt,
      duration: duration  
    };

    if (startImage) {
      input.start_image = startImage;
      console.log('✅ Adding start_image (first frame)');
    } else {
      input.aspect_ratio = aspectRatio;
    }

    if (endImage) {
      input.end_image = endImage;
      console.log('✅ Adding end_image (last frame) for interpolation');
    }

    console.log('🎬 Kling input:', input);

    const output = await replicate.run("kwaivgi/kling-v2.5-turbo-pro", { input });

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Kling API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


async function generateVideoWithKling26(prompt, startImage = null, duration = 5, aspectRatio = '16:9', generateAudio = false, audioParam = 'generate_audio') {
  try {
    console.log('Starting Kling v2.6 video generation:', {
      prompt: prompt.substring(0, 100),
      duration,
      aspectRatio,
      hasStartImage: !!startImage,
      generateAudio
    });

    const input = {
      prompt: prompt,
      duration: duration  
    };

    if (startImage) {
      input.start_image = startImage;
      console.log('✅ Adding start_image (first frame)');
    } else {
      input.aspect_ratio = aspectRatio;
    }

    if (audioParam) {
      input[audioParam] = !!generateAudio;
    }

    console.log('🎬 Kling v2.6 input:', input);

    const output = await replicate.run("kwaivgi/kling-v2.6", { input });

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Kling v2.6 API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


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


async function generateVideoWithRunwayTurbo(prompt, imageUrl = null, duration = 5, aspectRatio = '16:9') {
  try {
    console.log('Starting Runway Gen-4 Turbo video generation:', prompt);

    const input = {
      prompt: prompt,
      seconds: duration,
      aspect_ratio: aspectRatio
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


async function generateVideoWithSora2(prompt, seconds = 4, aspectRatio = 'portrait', inputReference = null) {
  try {
    console.log('Starting Sora 2 video generation:', prompt);

    const input = {
      prompt,
      seconds,
      aspect_ratio: aspectRatio
    };

    if (inputReference) {
      input.input_reference = inputReference;
    }

    const output = await replicate.run('openai/sora-2', { input });

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Sora 2 API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== AUDIO GENERATION ====================


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


async function generateVideoWithKlingMotion(imageUrl, videoUrl, mode = 'pro', characterOrientation = 'image', prompt = '', keepOriginalSound = false) {
  try {
    if (!imageUrl || !videoUrl) {
      throw new Error('Both image and reference video are required for Kling Motion Control');
    }

    const input = {
      mode: mode,                           
      image: imageUrl,
      video: videoUrl,
      character_orientation: characterOrientation,  
      keep_original_sound: keepOriginalSound
    };

    if (prompt && prompt.trim()) {
      input.prompt = prompt;
    }

    console.log(`🎬 Kling Motion Control: mode=${mode}, orientation=${characterOrientation}, sound=${keepOriginalSound}`);
    console.log(`📝 Prompt: ${prompt || '(none)'}`);

    const output = await replicate.run(
      "kwaivgi/kling-v2.6-motion-control",
      { input }
    );

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Kling Motion Control API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


async function generateVideoWithVeo(prompt, referenceImages = [], lastFrame = null, aspectRatio = '16:9', duration = 8, negativePrompt = '', startImage = null, generateAudio = true) {
  try {
    console.log(`Starting Veo 3.1 video generation:`, {
      prompt: prompt.substring(0, 100),
      aspectRatio,
      duration,
      generateAudio,
      referenceCount: referenceImages.length,
      hasLastFrame: !!lastFrame,
      hasStartImage: !!startImage
    });

    const input = {
      prompt: prompt,
      aspect_ratio: aspectRatio,  
      duration: Math.min(Math.max(duration, 4), 8),  
      resolution: '1080p',
      generate_audio: generateAudio  // true/false
    };

    if (startImage) {
      input.image = startImage;
      console.log(`✅ Adding start image (first frame) for image-to-video`);
    }

    if (referenceImages && referenceImages.length > 0 && aspectRatio === '16:9') {
      input.reference_images = referenceImages.slice(0, 3);  // Max 3 reference images
      console.log(`✅ Adding ${input.reference_images.length} reference image(s) for subject-consistent generation`);
    }

    if (!input.reference_images || input.reference_images.length === 0) {
      if (lastFrame) {
        input.last_frame = lastFrame;
        console.log(`✅ Adding last_frame for interpolation`);
      }
    }

    if (negativePrompt && negativePrompt.trim()) {
      input.negative_prompt = negativePrompt;
    }

    console.log(`🎬 Veo 3.1 input:`, {
      prompt_length: input.prompt.length,
      aspect_ratio: input.aspect_ratio,
      duration: input.duration,
      generate_audio: input.generate_audio,
      has_start_image: !!input.image,
      reference_images: input.reference_images?.length || 0,
      has_last_frame: !!input.last_frame,
      has_negative_prompt: !!input.negative_prompt
    });

    const output = await replicate.run(
      "google/veo-3.1",
      { input }
    );

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Veo 3.1 API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


async function generateVideoWithKlingO1Edit(options = {}) {
  try {
    const {
      prompt = '',
      referenceVideo = null,
      startImage = null,
      endImage = null,
      referenceImages = [],
      videoReferenceType = 'feature',  
      keepOriginalSound = true,  
      mode = 'pro',  
      aspectRatio = null,
      duration = 5
    } = options;

    if (!prompt || prompt.trim().length === 0) {
      throw new Error('Prompt is required for Kling O1 Edit');
    }

    const input = {
      prompt: prompt,
      mode: mode  
    };

    if (referenceVideo) {
      input.reference_video = referenceVideo;
      input.video_reference_type = videoReferenceType;  
      input.keep_original_sound = keepOriginalSound;
      
      if (videoReferenceType === 'feature' && duration) {
        input.duration = Math.min(Math.max(parseInt(duration), 3), 10);
      }
    } else {
      if (aspectRatio) {
        input.aspect_ratio = aspectRatio;
      }
      if (duration) {
        const validDuration = duration === 5 || duration === 10 ? duration : 5;
        input.duration = validDuration;
      }
    }

    if (startImage) {
      input.start_image = startImage;
      if (endImage) {
        input.end_image = endImage;
      }
    }

    if (referenceImages && referenceImages.length > 0) {
      const maxRefs = referenceVideo ? 4 : 7;
      input.reference_images = referenceImages.slice(0, maxRefs);
    }

    console.log(`✂️ Kling O1 Edit:`, {
      prompt: prompt.substring(0, 100),
      mode,
      hasVideo: !!referenceVideo,
      videoType: videoReferenceType,
      hasStartImage: !!startImage,
      hasEndImage: !!endImage,
      referenceImagesCount: input.reference_images?.length || 0,
      duration: input.duration,
      aspectRatio: input.aspect_ratio
    });

    const output = await replicate.run(
      "kwaivgi/kling-o1",
      { input }
    );

    return {
      success: true,
      videoUrl: Array.isArray(output) ? output[0] : output
    };

  } catch (error) {
    console.error('Kling O1 Edit API Error:', error);
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
  generateWithNanoBananaBase,
  generateWithSeedream, 
  generateWithClarityUpscaler,
  generateWithRecraftCrispUpscale,
  generateWithIdeogram,
  generateWithSuno,
  generateVideoWithRunwayTurbo,
  generateVideoWithKling,
  generateVideoWithKling26,
  generateVideoWithKlingMotion,
  generateVideoWithRunway,
  generateVideoWithSora2,
  generateVideoWithVeo,
  generateVideoWithKlingO1Edit
};
