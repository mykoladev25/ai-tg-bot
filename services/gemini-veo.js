const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

const VEO_QUALITY_MODEL = 'veo-3.1-generate-preview';
const VEO_FAST_MODEL = 'veo-3.1-fast-generate-preview';
const MAX_REFERENCE_IMAGES = 3;
const POLL_INTERVAL_MS = 10000;
const MAX_POLLS = 60;

function getClient() {
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

function detectMimeType(headers, url, data) {
  const ct = (headers['content-type'] || '').split(';')[0].trim();
  if (ct && ct.startsWith('image/') && ct !== 'application/octet-stream') return ct;

  const u = String(url || '').toLowerCase();
  if (u.includes('.png')) return 'image/png';
  if (u.includes('.webp')) return 'image/webp';
  if (u.includes('.gif')) return 'image/gif';
  if (u.includes('.jpg') || u.includes('.jpeg')) return 'image/jpeg';

  const b = Buffer.from(data).slice(0, 4);
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}

async function downloadImageAsGeminiImage(imageUrl) {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 45000
  });

  return {
    imageBytes: Buffer.from(response.data).toString('base64'),
    mimeType: detectMimeType(response.headers || {}, imageUrl, response.data)
  };
}

async function downloadVideoBuffer(ai, video) {
  if (video?.videoBytes) {
    return Buffer.from(video.videoBytes, 'base64');
  }

  const tempPath = path.join(
    os.tmpdir(),
    `gemini-veo-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`
  );

  try {
    await ai.files.download({
      file: video,
      downloadPath: tempPath
    });
    return await fs.promises.readFile(tempPath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

function getModelCode(model) {
  return model === 'veo3' ? VEO_QUALITY_MODEL : VEO_FAST_MODEL;
}

function extractOperationError(operation) {
  const err = operation?.error;
  if (!err) return 'Невідома помилка генерації Veo.';
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  if (typeof err.details === 'string' && err.details.trim()) return err.details.trim();
  return JSON.stringify(err).substring(0, 300);
}

function canGenerateDirect({ startImage, lastFrame, generateAudio = true } = {}) {
  if (generateAudio === false) return false;
  return !(lastFrame && !startImage);
}

async function generateVideo(prompt, options = {}) {
  if (!GEMINI_API_KEY) {
    return { success: false, error: 'Google Gemini API key not configured' };
  }

  const {
    model = 'veo3_fast',
    aspectRatio = '16:9',
    duration = 8,
    generateAudio = true,
    startImage = null,
    lastFrame = null,
    references = [],
    resolution
  } = options;

  if (!canGenerateDirect({ startImage, lastFrame, generateAudio })) {
    return {
      success: false,
      error: generateAudio === false
        ? 'Gemini Veo через Gemini API зараз не підтримує вимкнення audio.'
        : 'Gemini Veo підтримує last frame тільки разом зі start image.'
    };
  }

  try {
    const ai = getClient();
    const sourceImage = startImage ? await downloadImageAsGeminiImage(startImage) : undefined;
    const endFrame = lastFrame ? await downloadImageAsGeminiImage(lastFrame) : undefined;
    const referenceImages = Array.isArray(references)
      ? await Promise.all(
          references
            .slice(0, MAX_REFERENCE_IMAGES)
            .map(async (imageUrl) => ({
              image: await downloadImageAsGeminiImage(imageUrl),
              referenceType: 'ASSET'
            }))
        )
      : [];

    let operation = await ai.models.generateVideos({
      model: getModelCode(model),
      prompt,
      image: sourceImage,
      config: {
        aspectRatio,
        durationSeconds: duration,
        ...(resolution ? { resolution } : {}),
        ...(endFrame ? { lastFrame: endFrame } : {}),
        ...(referenceImages.length ? { referenceImages } : {})
      }
    });

    let pollCount = 0;
    while (!operation.done && pollCount < MAX_POLLS) {
      pollCount += 1;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      operation = await ai.operations.getVideosOperation({ operation });
    }

    if (!operation.done) {
      return {
        success: false,
        error: 'Google Gemini Veo не завершив генерацію вчасно. Спробуйте ще раз.'
      };
    }

    if (operation.error) {
      return { success: false, error: extractOperationError(operation) };
    }

    if ((operation.response?.raiMediaFilteredCount || 0) > 0) {
      const reasons = operation.response?.raiMediaFilteredReasons?.join(', ');
      return {
        success: false,
        error: reasons
          ? `Відео заблоковане політиками безпеки: ${reasons}`
          : 'Відео заблоковане політиками безпеки.'
      };
    }

    const video = operation.response?.generatedVideos?.[0]?.video;
    if (!video) {
      return { success: false, error: 'Google Gemini Veo не повернув відео.' };
    }

    const videoBuffer = await downloadVideoBuffer(ai, video);
    return {
      success: true,
      provider: 'google-gemini',
      videoBuffer,
      mimeType: video.mimeType || 'video/mp4'
    };
  } catch (error) {
    const errMsg = error?.message || String(error);
    return {
      success: false,
      error: `Помилка Gemini Veo: ${errMsg.substring(0, 200)}`
    };
  }
}

module.exports = {
  generateVideo,
  canGenerateDirect,
  VEO_QUALITY_MODEL,
  VEO_FAST_MODEL,
  get isConfigured() {
    return !!GEMINI_API_KEY;
  }
};
