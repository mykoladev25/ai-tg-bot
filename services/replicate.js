const axios = require('axios');
const { File } = require('buffer');
const {
  extractTelegramFileIdFromProxyUrl,
  extractTelegramFilePathFromProxyUrl,
  getTelegramBotToken,
  resolveServerSideTelegramFileUrlAsync
} = require('../utils/telegramFiles');

const Replicate = require('replicate');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});

const MAX_REPLICATE_FILE_UPLOAD_BYTES = 100 * 1024 * 1024;

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

function normalizeReplicateFileOutput(output) {
  const value = Array.isArray(output) ? output[0] : output;
  if (!value) return value;
  if (typeof value.url === 'function') {
    return value.url().toString();
  }
  if (typeof value.toString === 'function') {
    return value.toString();
  }
  return value;
}

function isTelegramMediaUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (extractTelegramFileIdFromProxyUrl(url) || extractTelegramFilePathFromProxyUrl(url)) return true;

  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === 'api.telegram.org'
      && parsed.pathname.includes('/file/bot');
  } catch (error) {
    return false;
  }
}

function inferFileExtension(contentType = '') {
  const normalized = String(contentType).split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a'
  };

  return map[normalized] || 'bin';
}

function inferFileName(sourceUrl, contentType, uploadPath) {
  try {
    const parsed = new URL(sourceUrl);
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || '').trim();
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) {
      return name;
    }
  } catch (error) {
  }

  const safeUploadPath = String(uploadPath || 'replicate-input')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    || 'replicate-input';
  return `${safeUploadPath}-${Date.now()}.${inferFileExtension(contentType)}`;
}

async function uploadTelegramMediaToReplicateFile(url, uploadPath = 'telegram-seedance-input') {
  let sourceUrl;
  try {
    sourceUrl = await resolveServerSideTelegramFileUrlAsync(url);
  } catch (error) {
    throw new Error(`Could not resolve Telegram media for Replicate: ${error.message}`);
  }

  const response = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxRedirects: 5,
    maxContentLength: MAX_REPLICATE_FILE_UPLOAD_BYTES
  });

  const buffer = Buffer.from(response.data);
  if (buffer.length > MAX_REPLICATE_FILE_UPLOAD_BYTES) {
    throw new Error('Uploaded media is too large for Replicate file upload. Max size is 100MiB.');
  }

  const contentType = String(response.headers?.['content-type'] || 'application/octet-stream')
    .split(';')[0]
    .trim()
    || 'application/octet-stream';
  const fileName = inferFileName(sourceUrl, contentType, uploadPath);
  const file = new File([buffer], fileName, { type: contentType });
  const uploadedFile = await replicate.files.create(file, {
    source: 'telegram',
    uploadPath
  });
  const replicateFileUrl = uploadedFile?.urls?.get;

  if (!replicateFileUrl) {
    throw new Error('Replicate file upload returned no file URL');
  }

  console.log('📤 Replicate media upload complete:', {
    uploadPath,
    fileName,
    contentType,
    bytes: buffer.length
  });

  return replicateFileUrl;
}

async function prepareReplicateMediaInput(url, uploadPath) {
  if (!url || typeof url !== 'string') return url;
  if (!isTelegramMediaUrl(url)) return url;

  return uploadTelegramMediaToReplicateFile(url, uploadPath);
}

async function prepareReplicateMediaInputs(urls, maxItems, uploadPath) {
  const list = Array.isArray(urls) ? urls.filter(Boolean).slice(0, maxItems) : [];
  return Promise.all(list.map((url) => prepareReplicateMediaInput(url, uploadPath)));
}

// ==================== IMAGE GENERATION ====================

/**
 * Generate an image with FLUX.
 */
async function generateWithFlux(prompt) {
  try {
    console.log('Starting FLUX generation:', prompt);

    const input = {
      prompt: prompt,
      aspect_ratio: '1:1',
      output_format: 'png',
      output_quality: 90,
      safety_tolerance: 2
    };

    const output = await replicate.run('black-forest-labs/flux-1.1-pro', { input });

    return {
      success: true,
      imageUrl: normalizeReplicateFileOutput(output)
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
      input.image = await prepareReplicateMediaInput(imageRef, 'telegram-stable-diffusion-image');
      input.prompt_strength = strength;
      console.log('Using image input (url), prompt_strength:', strength);
    } else {
      input.aspect_ratio = aspectRatio;
    }

    const output = await replicate.run('stability-ai/stable-diffusion-3.5-large', { input });

    return {
      success: true,
      imageUrl: normalizeReplicateFileOutput(output)
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

    const imageInputs = await prepareReplicateMediaInputs(
      normalizeImageInput(imageInput, 14),
      14,
      'telegram-nano-banana-pro-images'
    );

    const input = {
      prompt: prompt,
      resolution: resolution,
      image_input: imageInputs,
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
      imageUrl: normalizeReplicateFileOutput(output)
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

    const imageInputs = await prepareReplicateMediaInputs(
      normalizeImageInput(imageInput, 3),
      3,
      'telegram-nano-banana-images'
    );

    const input = {
      prompt: prompt,
      image_input: imageInputs,
      aspect_ratio: aspectRatio,
      output_format: outputFormat
    };

    if (input.image_input.length > 0) {
      console.log(`Using ${input.image_input.length} image(s) as input`);
    }

    const output = await replicate.run("google/nano-banana", { input });

    return {
      success: true,
      imageUrl: normalizeReplicateFileOutput(output)
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

    const imageInputs = await prepareReplicateMediaInputs(
      normalizeImageInput(imageInput, 14),
      14,
      'telegram-seedream-images'
    );

    const input = {
      size: size,
      prompt: prompt,
      max_images: 1,
      image_input: imageInputs,
      aspect_ratio: aspectRatio,
      sequential_image_generation: "disabled"
    };

    if (input.image_input.length > 0) {
      console.log(`Using ${input.image_input.length} image(s) as input`);
    }

    const output = await replicate.run("bytedance/seedream-4.5", { input });

    return {
      success: true,
      imageUrl: normalizeReplicateFileOutput(output)
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
        input.style_reference_images = [
          await prepareReplicateMediaInput(imageUrl, 'telegram-ideogram-style-image')
        ];
        input.image_weight = imageWeight; // 0.0-1.0 (default 0.5)
        console.log(`Using 1 image as style_reference_images (url), weight: ${imageWeight}`);
      }
    }

    const output = await replicate.run("ideogram-ai/ideogram-v3-turbo", { input });

    return {
      success: true,
      imageUrl: normalizeReplicateFileOutput(output)
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
      image: await prepareReplicateMediaInput(imageUrl, 'telegram-clarity-image'),
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
      imageUrl: normalizeReplicateFileOutput(output)
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
      image: await prepareReplicateMediaInput(imageUrl, 'telegram-recraft-image')
    };

    const output = await replicate.run(
      'recraft-ai/recraft-crisp-upscale',
      { input }
    );

    return {
      success: true,
      imageUrl: normalizeReplicateFileOutput(output)
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
      input.start_image = await prepareReplicateMediaInput(startImage, 'telegram-kling-start-image');
      console.log('✅ Adding start_image (first frame)');
    } else {
      input.aspect_ratio = aspectRatio;
    }

    if (endImage) {
      input.end_image = await prepareReplicateMediaInput(endImage, 'telegram-kling-end-image');
      console.log('✅ Adding end_image (last frame) for interpolation');
    }

    console.log('🎬 Kling input:', input);

    const output = await replicate.run("kwaivgi/kling-v2.5-turbo-pro", { input });

    return {
      success: true,
      videoUrl: normalizeReplicateFileOutput(output)
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
      input.start_image = await prepareReplicateMediaInput(startImage, 'telegram-kling26-start-image');
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
      videoUrl: normalizeReplicateFileOutput(output)
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
      input.prompt_image = await prepareReplicateMediaInput(imageUrl, 'telegram-runway-gen4-image');
    }

    const output = await replicate.run("runwayml/gen4-aleph", { input });

    return {
      success: true,
      videoUrl: normalizeReplicateFileOutput(output)
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
      duration: duration,
      aspect_ratio: aspectRatio
    };

    if (imageUrl) {
      input.image = await prepareReplicateMediaInput(imageUrl, 'telegram-runway-turbo-image');
    }

    const output = await replicate.run("runwayml/gen4-turbo", { input });

    return {
      success: true,
      videoUrl: normalizeReplicateFileOutput(output)
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
      input.input_reference = await prepareReplicateMediaInput(inputReference, 'telegram-sora2-reference-image');
    }

    const output = await replicate.run('openai/sora-2', { input });

    return {
      success: true,
      videoUrl: normalizeReplicateFileOutput(output)
    };

  } catch (error) {
    console.error('Sora 2 API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function generateVideoWithSeedance2(prompt, options = {}) {
  try {
    if (!prompt) {
      throw new Error('Prompt is required for Seedance 2');
    }

    const {
      modelKey = 'seedance_2',
      inputMode = null,
      firstFrameUrl = null,
      lastFrameUrl = null,
      referenceImageUrls = [],
      referenceVideoUrls = [],
      referenceAudioUrls = [],
      generateAudio = true,
      resolution = '480p',
      aspectRatio = '16:9',
      duration = 4,
      seed = undefined
    } = options;

    const replicateModel = modelKey === 'seedance_2_fast'
      ? 'bytedance/seedance-2.0-fast'
      : 'bytedance/seedance-2.0';

    const allowedResolutions = modelKey === 'seedance_2_fast'
      ? ['480p', '720p']
      : ['480p', '720p', '1080p'];
    const safeResolution = allowedResolutions.includes(resolution) ? resolution : allowedResolutions[0];
    const safeAspectRatio = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', '9:21', 'adaptive'].includes(aspectRatio)
      ? aspectRatio
      : '16:9';
    const safeDuration = Math.max(-1, Math.min(15, Number(duration) || 4));
    const imageRefs = Array.isArray(referenceImageUrls)
      ? referenceImageUrls.filter(Boolean).slice(0, 9)
      : [];
    const videoRefs = Array.isArray(referenceVideoUrls)
      ? referenceVideoUrls.filter(Boolean).slice(0, 3)
      : [];
    const audioRefs = Array.isArray(referenceAudioUrls)
      ? referenceAudioUrls.filter(Boolean).slice(0, 3)
      : [];
    const hasFrameInputs = !!firstFrameUrl || !!lastFrameUrl;
    const hasReferenceInputs = imageRefs.length > 0 || videoRefs.length > 0 || audioRefs.length > 0;

    const normalizedInputMode = inputMode === 'frames' || inputMode === 'multimodal' || inputMode === 'text'
      ? inputMode
      : hasFrameInputs
        ? 'frames'
        : hasReferenceInputs
          ? 'multimodal'
          : 'text';

    if (hasFrameInputs && hasReferenceInputs) {
      throw new Error('Seedance 2 on Replicate does not allow mixing first/last frame inputs with multimodal references');
    }

    if (audioRefs.length > 0 && imageRefs.length === 0 && videoRefs.length === 0) {
      throw new Error('Seedance 2 on Replicate requires at least one reference image or reference video when using reference audio');
    }

    const input = {
      prompt,
      duration: safeDuration,
      resolution: safeResolution,
      aspect_ratio: safeAspectRatio,
      generate_audio: !!generateAudio
    };

    if (Number.isInteger(seed)) {
      input.seed = seed;
    }

    if (normalizedInputMode === 'frames') {
      if (!firstFrameUrl) {
        throw new Error('First frame image is required for Seedance frames mode');
      }
      input.image = await prepareReplicateMediaInput(firstFrameUrl, 'telegram-seedance-first-frame');
      if (lastFrameUrl) {
        input.last_frame_image = await prepareReplicateMediaInput(lastFrameUrl, 'telegram-seedance-last-frame');
      }
    } else {
      const [preparedImageRefs, preparedVideoRefs, preparedAudioRefs] = await Promise.all([
        prepareReplicateMediaInputs(imageRefs, 9, 'telegram-seedance-reference-images'),
        prepareReplicateMediaInputs(videoRefs, 3, 'telegram-seedance-reference-videos'),
        prepareReplicateMediaInputs(audioRefs, 3, 'telegram-seedance-reference-audios')
      ]);

      if (preparedImageRefs.length > 0) {
        input.reference_images = preparedImageRefs;
      }
      if (preparedVideoRefs.length > 0) {
        input.reference_videos = preparedVideoRefs;
      }
      if (preparedAudioRefs.length > 0) {
        input.reference_audios = preparedAudioRefs;
      }
    }

    console.log('🎞️ Seedance 2 Replicate input:', {
      modelKey,
      prompt: prompt.substring(0, 100),
      duration: input.duration,
      resolution: input.resolution,
      aspect_ratio: input.aspect_ratio,
      generate_audio: input.generate_audio,
      has_image: !!input.image,
      has_last_frame: !!input.last_frame_image,
      reference_images: input.reference_images?.length || 0,
      reference_videos: input.reference_videos?.length || 0,
      reference_audios: input.reference_audios?.length || 0
    });

    const output = await replicate.run(replicateModel, { input });

    return {
      success: true,
      videoUrl: normalizeReplicateFileOutput(output)
    };
  } catch (error) {
    console.error('Seedance 2 Replicate API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function generateVideoWithPVideo(prompt, options = {}) {
  try {
    if (!prompt) {
      throw new Error('Prompt is required for P-Video');
    }

    const {
      imageUrl = null,
      lastFrameUrl = null,
      audioUrl = null,
      duration = 5,
      resolution = '720p',
      aspectRatio = '16:9',
      fps = 24,
      draft = false,
      saveAudio = true,
      promptUpsampling = true,
      disableSafetyFilter = false,
      seed = undefined
    } = options;

    const safeResolution = ['720p', '1080p'].includes(resolution) ? resolution : '720p';
    const safeAspectRatio = ['16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '1:1'].includes(aspectRatio)
      ? aspectRatio
      : '16:9';
    const safeDuration = Math.max(1, Math.min(20, Number(duration) || 5));
    const safeFps = [24, 48].includes(Number(fps)) ? Number(fps) : 24;

    const input = {
      prompt,
      duration: safeDuration,
      resolution: safeResolution,
      aspect_ratio: safeAspectRatio,
      fps: safeFps,
      draft: !!draft,
      save_audio: !!saveAudio,
      prompt_upsampling: !!promptUpsampling,
      disable_safety_filter: !!disableSafetyFilter
    };

    if (Number.isInteger(seed)) {
      input.seed = seed;
    }

    if (imageUrl) {
      input.image = await prepareReplicateMediaInput(imageUrl, 'telegram-p-video-image');
    }
    if (lastFrameUrl) {
      input.last_frame_image = await prepareReplicateMediaInput(lastFrameUrl, 'telegram-p-video-last-frame');
    }
    if (audioUrl) {
      input.audio = await prepareReplicateMediaInput(audioUrl, 'telegram-p-video-audio');
    }

    console.log('⚡ P-Video Replicate input:', {
      prompt: prompt.substring(0, 100),
      duration: input.duration,
      resolution: input.resolution,
      aspect_ratio: input.aspect_ratio,
      fps: input.fps,
      draft: input.draft,
      has_image: !!input.image,
      has_last_frame: !!input.last_frame_image,
      has_audio: !!input.audio
    });

    const output = await replicate.run('prunaai/p-video', { input });

    return {
      success: true,
      videoUrl: normalizeReplicateFileOutput(output)
    };
  } catch (error) {
    console.error('P-Video Replicate API Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function generateVideoWithFabric10(options = {}) {
  try {
    const {
      imageUrl = null,
      audioUrl = null,
      resolution = '720p'
    } = options;

    if (!imageUrl) {
      throw new Error('Image is required for Fabric 1.0');
    }
    if (!audioUrl) {
      throw new Error('Audio is required for Fabric 1.0');
    }

    const input = {
      image: await prepareReplicateMediaInput(imageUrl, 'telegram-fabric-image'),
      audio: await prepareReplicateMediaInput(audioUrl, 'telegram-fabric-audio'),
      resolution: ['480p', '720p'].includes(resolution) ? resolution : '720p'
    };

    console.log('🗣️ Fabric 1.0 Replicate input:', {
      resolution: input.resolution,
      has_image: !!input.image,
      has_audio: !!input.audio
    });

    const output = await replicate.run('veed/fabric-1.0', { input });

    return {
      success: true,
      videoUrl: normalizeReplicateFileOutput(output)
    };
  } catch (error) {
    console.error('Fabric 1.0 Replicate API Error:', error);
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
      image: await prepareReplicateMediaInput(imageUrl, 'telegram-kling-motion-image'),
      video: await prepareReplicateMediaInput(videoUrl, 'telegram-kling-motion-video'),
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
      videoUrl: normalizeReplicateFileOutput(output)
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
      input.image = await prepareReplicateMediaInput(startImage, 'telegram-veo-start-image');
      console.log(`✅ Adding start image (first frame) for image-to-video`);
    }

    if (referenceImages && referenceImages.length > 0 && aspectRatio === '16:9') {
      input.reference_images = await prepareReplicateMediaInputs(referenceImages, 3, 'telegram-veo-reference-images');
      console.log(`✅ Adding ${input.reference_images.length} reference image(s) for subject-consistent generation`);
    }

    if (!input.reference_images || input.reference_images.length === 0) {
      if (lastFrame) {
        input.last_frame = await prepareReplicateMediaInput(lastFrame, 'telegram-veo-last-frame');
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
      videoUrl: normalizeReplicateFileOutput(output)
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
      input.reference_video = await prepareReplicateMediaInput(referenceVideo, 'telegram-kling-o1-reference-video');
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
      input.start_image = await prepareReplicateMediaInput(startImage, 'telegram-kling-o1-start-image');
      if (endImage) {
        input.end_image = await prepareReplicateMediaInput(endImage, 'telegram-kling-o1-end-image');
      }
    }

    if (referenceImages && referenceImages.length > 0) {
      const maxRefs = referenceVideo ? 4 : 7;
      input.reference_images = await prepareReplicateMediaInputs(referenceImages, maxRefs, 'telegram-kling-o1-reference-images');
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
      videoUrl: normalizeReplicateFileOutput(output)
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
  generateVideoWithSeedance2,
  generateVideoWithPVideo,
  generateVideoWithFabric10,
  generateVideoWithVeo,
  generateVideoWithKlingO1Edit
};
