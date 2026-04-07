

const axios = require('axios');
const FormData = require('form-data');
const {
  DEFAULT_PROVIDER_PROXY_TTL_SECONDS,
  buildTelegramFileIdProxyUrl,
  buildTelegramFileProxyUrl,
  extractTelegramFileIdFromProxyUrl,
  extractTelegramFilePathFromProxyUrl,
  resolveServerSideTelegramFileUrlAsync
} = require('../utils/telegramFiles');

const KIE_API_BASE = 'https://api.kie.ai/api/v1';
const KIE_FILE_UPLOAD_API_URL = 'https://kieai.redpandaai.co/api/file-url-upload';
const KIE_FILE_STREAM_UPLOAD_API_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';
const KIE_API_KEY = process.env.KIE_AI_API_KEY;
const accessControl = require('../config/access');
const TELEGRAM_PROVIDER_PROXY_TTL_SECONDS = Number.parseInt(process.env.TELEGRAM_PROVIDER_PROXY_TTL_SECONDS, 10) > 0
  ? Number.parseInt(process.env.TELEGRAM_PROVIDER_PROXY_TTL_SECONDS, 10)
  : DEFAULT_PROVIDER_PROXY_TTL_SECONDS;

// ==================== HELPER FUNCTIONS ====================


function isAdminUser(userId) {
  return accessControl.isAdmin(userId);
}

function normalizeProviderInputUrl(url) {
  if (typeof url !== 'string' || !url) {
    return url;
  }

  const fileId = extractTelegramFileIdFromProxyUrl(url);
  if (fileId) {
    try {
      return buildTelegramFileIdProxyUrl(fileId, {
        ttlSeconds: TELEGRAM_PROVIDER_PROXY_TTL_SECONDS
      });
    } catch (error) {
      console.warn(`⚠️ Failed to rebuild Telegram file-id proxy URL: ${error.message}`);
      return url;
    }
  }

  const filePath = extractTelegramFilePathFromProxyUrl(url);
  if (filePath) {
    return buildTelegramFileProxyUrl(filePath, {
      ttlSeconds: TELEGRAM_PROVIDER_PROXY_TTL_SECONDS
    });
  }

  return url;
}

function normalizeProviderInputUrls(input, maxItems = null) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const normalized = list
    .map(normalizeProviderInputUrl)
    .filter(Boolean);

  return Number.isFinite(maxItems) ? normalized.slice(0, maxItems) : normalized;
}

function isKieTempFileUrl(url) {
  if (typeof url !== 'string' || !url) {
    return false;
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.endsWith('tempfile.redpandaai.co');
  } catch (error) {
    return false;
  }
}

function inferExtensionFromMimeType(mimeType = '') {
  const normalizedMimeType = String(mimeType).split(';')[0].trim().toLowerCase();
  const mimeToExtension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a'
  };

  return mimeToExtension[normalizedMimeType] || 'bin';
}

function buildUploadFileName(sourceUrl, headers = {}, uploadPath = 'telegram-inputs') {
  try {
    const parsed = new URL(sourceUrl);
    const rawName = decodeURIComponent(parsed.pathname.split('/').pop() || '').trim();
    if (rawName && /\.[a-z0-9]{2,5}$/i.test(rawName)) {
      return rawName;
    }
  } catch (error) {
  }

  const extension = inferExtensionFromMimeType(headers['content-type']);
  const safeUploadPath = String(uploadPath || 'telegram-inputs').replace(/[^a-z0-9_-]+/gi, '-');
  return `${safeUploadPath}-${Date.now()}.${extension}`;
}

function extractKieUploadedFileUrl(responseData) {
  const data = responseData?.data || {};
  return data.fileUrl || data.downloadUrl || null;
}

async function uploadFileStreamToKie(fileUrl, uploadPath = 'telegram-inputs') {
  const normalizedUrl = normalizeProviderInputUrl(fileUrl);
  if (!normalizedUrl || isKieTempFileUrl(normalizedUrl)) {
    return normalizedUrl;
  }

  const sourceUrl = await resolveServerSideTelegramFileUrlAsync(normalizedUrl);
  const sourceResponse = await axios.get(sourceUrl, {
    responseType: 'stream',
    timeout: 45000,
    maxRedirects: 5
  });

  const form = new FormData();
  form.append('file', sourceResponse.data, {
    filename: buildUploadFileName(sourceUrl, sourceResponse.headers || {}, uploadPath),
    contentType: sourceResponse.headers?.['content-type'] || 'application/octet-stream'
  });
  form.append('uploadPath', uploadPath);

  const uploadResponse = await axios.post(
    KIE_FILE_STREAM_UPLOAD_API_URL,
    form,
    {
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
        ...form.getHeaders()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 60000
    }
  );

  const cachedUrl = extractKieUploadedFileUrl(uploadResponse?.data);
  if (!cachedUrl) {
    throw new Error(uploadResponse?.data?.msg || 'KIE stream upload returned no file URL');
  }

  return cachedUrl;
}

async function cacheRemoteFileForKie(url, uploadPath = 'telegram-inputs') {
  const normalizedUrl = normalizeProviderInputUrl(url);
  if (!normalizedUrl || isKieTempFileUrl(normalizedUrl)) {
    return normalizedUrl;
  }

  let uploadSourceUrl = normalizedUrl;
  try {
    uploadSourceUrl = await resolveServerSideTelegramFileUrlAsync(normalizedUrl);
  } catch (resolveError) {
    console.warn(`⚠️ Telegram server-side file resolve failed for ${uploadPath}: ${resolveError.message}`);
  }

  try {
    return await uploadFileStreamToKie(uploadSourceUrl, uploadPath);
  } catch (streamError) {
    console.warn(`⚠️ KIE file stream upload failed for ${uploadPath}: ${streamError.response?.data?.msg || streamError.message}`);
  }

  try {
    const response = await axios.post(
      KIE_FILE_UPLOAD_API_URL,
      {
        fileUrl: uploadSourceUrl,
        uploadPath
      },
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 45000
      }
    );

    const cachedUrl = extractKieUploadedFileUrl(response?.data);
    if (cachedUrl) {
      return cachedUrl;
    }

    console.warn('⚠️ KIE file cache: no fileUrl/downloadUrl returned, using original URL');
    return normalizedUrl;
  } catch (error) {
    console.warn(`⚠️ KIE file cache failed for ${uploadPath}: ${error.response?.data?.msg || error.message}`);
    return normalizedUrl;
  }
}

async function cacheRemoteFilesForKie(input, options = {}) {
  const {
    maxItems = null,
    uploadPath = 'telegram-inputs'
  } = options;

  const urls = normalizeProviderInputUrls(input, maxItems);
  return Promise.all(urls.map((url) => cacheRemoteFileForKie(url, uploadPath)));
}


async function fetchTaskRecordInfo(taskId) {
  const response = await axios.get(
    `${KIE_API_BASE}/jobs/recordInfo`,
    {
      params: { taskId },
      headers: {
        'Authorization': `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data?.data || null;
}


async function pollJobStatus(taskId, maxAttempts = 400, interval = 3000, modelName = 'KIE.AI') {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const job = await fetchTaskRecordInfo(taskId);
      if (!job) {
        console.warn(`⚠️ ${modelName} recordInfo empty for ${taskId}`);
        await new Promise(resolve => setTimeout(resolve, interval));
        attempts++;
        continue;
      }

      const state = (job.state || job.status || '').toLowerCase();

      console.log(`📊 ${modelName} status (attempt ${attempts + 1}): ${state}`);

      if (state === 'success' || state === 'completed') {
        return job;
      }
      if (state === 'fail' || state === 'failed' || state === 'error') {
        const errorMsg = job.failMsg || job.failCode || job.error || 'Unknown error';
        throw new Error(`Task failed: ${errorMsg}`);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`⚠️ Task ${taskId} not found, retrying...`);
      } else if (error.message.includes('Task failed')) {
        throw error;
      } else {
        console.error(`⚠️ Polling error:`, error.message);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    }
  }

  await new Promise(resolve => setTimeout(resolve, interval));
  try {
    const job = await fetchTaskRecordInfo(taskId);
    const state = (job?.state || job?.status || '').toLowerCase();
    if (state === 'success' || state === 'completed') {
      console.log(`📊 ${modelName} got result on final check`);
      return job;
    }
  } catch (e) {
  }

  console.warn(`⏱️ ${modelName} task ${taskId} timed out after polling. Returning pending state.`);
  return { _timeout: true, taskId };
}


function normalizeImageInput(imageInput, maxImages = 3) {
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


function extractImageUrl(result) {
  if (!result) return null;

  if (Array.isArray(result) && result.length > 0 && typeof result[0] === 'string') {
    return result[0];
  }
  if (Array.isArray(result.output) && result.output.length > 0 && typeof result.output[0] === 'string') {
    return result.output[0];
  }

  if (result.resultJson) {
    try {
      const parsed = JSON.parse(result.resultJson);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
        return parsed[0];
      }
      if (parsed.resultUrls && parsed.resultUrls.length > 0) {
        return parsed.resultUrls[0];
      }
    } catch (e) {
      console.warn('Failed to parse resultJson:', e.message);
    }
  }

  if (result.output?.image_url) {
    return result.output.image_url;
  }

  if (result.output?.resultUrls && result.output.resultUrls.length > 0) {
    return result.output.resultUrls[0];
  }

  if (result.result_url) {
    return result.result_url;
  }

  return null;
}


async function fetchVeoTaskInfo(taskId) {
  try {
    const recordInfoResp = await axios.get(
      `${KIE_API_BASE}/veo/record-info?taskId=${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    if (recordInfoResp.data?.code === 200 && recordInfoResp.data?.data) {
      const data = recordInfoResp.data.data;
      let state = (data.state || data.status || '').toLowerCase();
      if (!state && data.successFlag === 1) state = 'success';
      if (!state && data.successFlag === 0 && data.errorMessage) state = 'fail';
      if (!state && data.completeTime && data.response) state = 'success';
      // ✅ Detect 'waiting' state: no state, no successFlag, no completeTime
      if (!state && (data.successFlag === null || data.successFlag === undefined) && !data.completeTime) {
        state = 'waiting';
      }
      if (!data.state && state) data.state = state;

      console.log(`📡 Veo /veo/record-info: taskId=${taskId}, state=${state}, successFlag=${data.successFlag}, completeTime=${data.completeTime || 'null'}, keys=${Object.keys(data).join(',')}`);

      if (state === 'success' || state === 'completed') {
        console.log(`📡 Veo record-info SUCCESS FULL DATA: ${JSON.stringify(data).substring(0, 2000)}`);
        if (data.response) console.log(`📡 Veo response: ${JSON.stringify(data.response).substring(0, 500)}`);
        if (data.info) console.log(`📡 Veo info: ${JSON.stringify(data.info).substring(0, 500)}`);
        if (data.resultJson) console.log(`📡 Veo resultJson: ${String(data.resultJson).substring(0, 500)}`);
      }
      return data;
    } else {
      console.log(`📡 Veo /veo/record-info: code=${recordInfoResp.data?.code}, msg=${recordInfoResp.data?.msg}, data=${JSON.stringify(recordInfoResp.data?.data || {}).substring(0, 300)}`);
    }
  } catch (e) {
    if (e.response?.status !== 404 && e.response?.status !== 400) {
      console.warn(`⚠️ /veo/record-info failed (${e.response?.status || e.message}), trying record-detail...`);
    }
  }

  // ===== METHOD 2: /veo/record-detail =====
  try {
    const response = await axios.get(
      `${KIE_API_BASE}/veo/record-detail?taskId=${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    if (response.data?.data) {
      const data = response.data.data;
      let state = (data.state || data.status || '').toLowerCase();
      if (!state && data.successFlag === 1) state = 'success';
      if (!state && data.successFlag === 0 && data.errorMessage) state = 'fail';
      if (!state && data.completeTime && data.response) state = 'success';
      // ✅ Detect 'waiting' state: no state, no successFlag, no completeTime
      if (!state && (data.successFlag === null || data.successFlag === undefined) && !data.completeTime) {
        state = 'waiting';
      }
      if (!data.state && state) data.state = state;

      console.log(`📡 Veo /veo/record-detail: taskId=${taskId}, state=${state || 'EMPTY'}, successFlag=${data.successFlag}, completeTime=${data.completeTime || 'null'}, keys=${Object.keys(data).join(',')}`);

      if (state === 'success' || state === 'completed') {
        console.log(`📡 Veo record-detail SUCCESS FULL DATA: ${JSON.stringify(data).substring(0, 2000)}`);
        if (data.response) console.log(`📡 Veo response: ${JSON.stringify(data.response).substring(0, 500)}`);
        if (data.info) console.log(`📡 Veo info: ${JSON.stringify(data.info).substring(0, 500)}`);
        if (data.resultJson) console.log(`📡 Veo resultJson: ${String(data.resultJson).substring(0, 500)}`);
      }
      return data;
    }
  } catch (e) {
    if (e.response?.status !== 404 && e.response?.status !== 400) {
      console.warn(`⚠️ /veo/record-detail failed (${e.response?.status || e.message}), falling back to /jobs/recordInfo`);
    }
  }

  // ===== METHOD 3: Fallback /jobs/recordInfo =====
  const fallbackResult = await fetchTaskRecordInfo(taskId);
  if (fallbackResult) {
    const state = (fallbackResult.state || fallbackResult.status || '').toLowerCase();
    console.log(`📡 Veo /jobs/recordInfo: taskId=${taskId}, state=${state}, keys=${Object.keys(fallbackResult).join(',')}`);
    if (state === 'success' || state === 'completed') {
      console.log(`📡 Veo /jobs/recordInfo SUCCESS: ${JSON.stringify(fallbackResult).substring(0, 1000)}`);
    }
  } else {
    console.warn(`⚠️ Veo /jobs/recordInfo returned null for taskId=${taskId}`);
  }
  return fallbackResult;
}


function extractVideoUrl(result) {
  if (!result) return null;

  console.log(`🔍 extractVideoUrl: keys=${Object.keys(result).join(',')}, info=${!!result.info}, resultJson=${!!result.resultJson}, response=${!!result.response}`);

  // ✅ Veo record-detail format: { response: { resultUrls: ["url"], originUrls: ["url"] } }
  if (result.response?.resultUrls) {
    let urls = result.response.resultUrls;
    if (typeof urls === 'string') {
      try { urls = JSON.parse(urls); } catch (e) {
        if (urls.startsWith('http')) {
          console.log(`📹 Veo video URL from response.resultUrls (plain): ${urls}`);
          return urls;
        }
      }
    }
    if (Array.isArray(urls) && urls.length > 0) {
      console.log(`📹 Veo video URL from response.resultUrls: ${urls[0]}`);
      return urls[0];
    }
  }

  // ✅ Veo record-detail: response.originUrls (original when aspect_ratio != 16:9)
  if (result.response?.originUrls) {
    let originUrls = result.response.originUrls;
    if (typeof originUrls === 'string') {
      try { originUrls = JSON.parse(originUrls); } catch (e) {
        if (originUrls.startsWith('http')) return originUrls;
      }
    }
    if (Array.isArray(originUrls) && originUrls.length > 0) {
      console.log(`📹 Veo video URL from response.originUrls: ${originUrls[0]}`);
      return originUrls[0];
    }
  }

  // Veo callback/record-detail format: { info: { resultUrls: '["url"]' } }
  if (result.info?.resultUrls) {
    let urls = result.info.resultUrls;
    if (typeof urls === 'string') {
      try {
        urls = JSON.parse(urls);
        console.log(`📹 Veo info.resultUrls parsed from string: ${JSON.stringify(urls)}`);
      } catch (e) {
        if (urls.startsWith('http')) {
          console.log(`📹 Veo info.resultUrls is plain URL: ${urls}`);
          return urls;
        }
        console.warn(`⚠️ Failed to parse info.resultUrls: ${e.message}, raw: ${urls.substring(0, 200)}`);
      }
    }
    if (Array.isArray(urls) && urls.length > 0) {
      console.log(`📹 Veo video URL from info.resultUrls: ${urls[0]}`);
      return urls[0];
    }
  }

  // Veo callback: info.originUrls (original video when aspect_ratio != 16:9)
  if (result.info?.originUrls) {
    let originUrls = result.info.originUrls;
    if (typeof originUrls === 'string') {
      try {
        originUrls = JSON.parse(originUrls);
      } catch (e) {
        if (originUrls.startsWith('http')) return originUrls;
      }
    }
    if (Array.isArray(originUrls) && originUrls.length > 0) {
      console.log(`📹 Veo video URL from info.originUrls: ${originUrls[0]}`);
      return originUrls[0];
    }
  }

  // Veo record-detail format: { videoInfo: { videoUrl: '...' } }
  if (result.videoInfo?.videoUrl) {
    console.log(`📹 Veo video URL from videoInfo.videoUrl: ${result.videoInfo.videoUrl}`);
    return result.videoInfo.videoUrl;
  }

  // Standard /jobs/recordInfo format: { resultJson: '{"resultUrls":[...]}' }
  if (result.resultJson) {
    try {
      const parsed = typeof result.resultJson === 'string' ? JSON.parse(result.resultJson) : result.resultJson;
      if (parsed.resultUrls) {
        let rUrls = parsed.resultUrls;
        if (typeof rUrls === 'string') {
          try { rUrls = JSON.parse(rUrls); } catch (e) {
            if (rUrls.startsWith('http')) return rUrls;
          }
        }
        if (Array.isArray(rUrls) && rUrls.length > 0) {
          console.log(`📹 Video URL from resultJson.resultUrls: ${rUrls[0]}`);
          return rUrls[0];
        }
      }
    } catch (e) {
      console.warn('Failed to parse resultJson:', e.message);
    }
  }

  if (result.output?.video_url) {
    console.log(`📹 Video URL from output.video_url: ${result.output.video_url}`);
    return result.output.video_url;
  }

  if (result.output?.resultUrls) {
    let oUrls = result.output.resultUrls;
    if (typeof oUrls === 'string') {
      try { oUrls = JSON.parse(oUrls); } catch (e) {
        if (oUrls.startsWith('http')) return oUrls;
      }
    }
    if (Array.isArray(oUrls) && oUrls.length > 0) {
      console.log(`📹 Video URL from output.resultUrls: ${oUrls[0]}`);
      return oUrls[0];
    }
  }

  if (result.result_url) {
    console.log(`📹 Video URL from result_url: ${result.result_url}`);
    return result.result_url;
  }

  try {
    const resultStr = JSON.stringify(result);
    const urlMatch = resultStr.match(/https?:\/\/[^\s"\\,\]]+\.mp4/);
    if (urlMatch) {
      console.log(`📹 Video URL from brute-force regex: ${urlMatch[0]}`);
      return urlMatch[0];
    }
  } catch (e) {  }

  console.warn(`⚠️ extractVideoUrl: no video URL found in result. Full result keys: ${Object.keys(result).join(',')}, info keys: ${result.info ? Object.keys(result.info).join(',') : 'N/A'}, response keys: ${result.response ? Object.keys(result.response).join(',') : 'N/A'}`);
  return null;
}


async function fetchVeo1080pUrl(taskId) {
  try {
    console.log(`🔄 Trying /veo/get-1080p-video for taskId=${taskId}...`);
    const resp = await axios.get(
      `${KIE_API_BASE}/veo/get-1080p-video?taskId=${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    console.log(`📥 Veo get-1080p-video response: code=${resp.data?.code}, msg=${resp.data?.msg}, data=${JSON.stringify(resp.data?.data || {}).substring(0, 300)}`);
    if (resp.data?.code === 200 && resp.data?.data?.resultUrl) {
      console.log(`✅ Veo 1080p URL: ${resp.data.data.resultUrl.substring(0, 100)}`);
      return resp.data.data.resultUrl;
    }
    // code 400 = "1080P is processing. It should be ready in 1-2 minutes"
    if (resp.data?.code === 400) {
      console.log(`⏳ Veo 1080p still processing: ${resp.data?.msg}`);
      return null;
    }
    console.warn(`⚠️ Veo get-1080p-video unexpected: code=${resp.data?.code}, msg=${resp.data?.msg}, full=${JSON.stringify(resp.data).substring(0, 500)}`);
    return null;
  } catch (e) {
    console.warn(`⚠️ Veo get-1080p-video failed: status=${e.response?.status}, data=${JSON.stringify(e.response?.data || {}).substring(0, 300)}, msg=${e.message}`);
    return null;
  }
}

// ==================== IMAGE GENERATION ====================


async function generateWithNanoBananaBaseKieAI(prompt, imageInput = null, imageSize = "1:1", outputFormat = "png") {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Nano Banana');
    }

    const truncatedPrompt = prompt.length > 20000 ? prompt.substring(0, 20000) : prompt;

    const images = imageInput ? normalizeImageInput(imageInput, 3) : [];
    const isText2Img = images.length === 0;

    console.log(`🎨 KIE.AI Nano Banana Base (${isText2Img ? 'text2img' : 'img2img'}):`, {
      prompt: truncatedPrompt.substring(0, 100),
      imageSize,
      outputFormat,
      imageCount: images.length
    });

    // https://docs.kie.ai/market/google/nano-banana
    const payload = {
      model: 'google/nano-banana',
      input: {
        prompt: truncatedPrompt,
        image_size: imageSize || '1:1',
        output_format: outputFormat || 'png'
      }
    };

    console.log(`📤 KIE.AI Nano Banana Base request:`, {
      model: payload.model,
      mode: isText2Img ? 'text2img' : 'img2img',
      images: images.length,
      imageSize
    });

    try {
      const kiePricingSync = require('./kie-pricing-sync');
      const kiePrice = kiePricingSync.getModelPriceSync('nano_banana');
      if (kiePrice) {
        console.log(`💰 KIE.AI price: $${kiePrice}`);
      }
    } catch (err) {
    }

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Nano Banana Base response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      const responseCode = createResponse?.data?.code;
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (responseCode === 500) {
        console.error('❌ KIE.AI Nano Banana Base - Server Error 500:', createResponse?.data);
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
          provider: 'kie-ai',
          serverError: true
        };
      }

      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${apiMsg || JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 600, 5000, 'Nano Banana Base (KIE.AI)');

    const imageUrl = extractImageUrl(result);
    if (!imageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Nano Banana Base Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateWithZImageKieAI(prompt, aspectRatio = "1:1") {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Z-Image');
    }

    const truncatedPrompt = prompt.length > 1000 ? prompt.substring(0, 1000) : prompt;

    console.log(`⚡ KIE.AI Z-Image (text2img):`, {
      prompt: truncatedPrompt.substring(0, 100),
      aspectRatio
    });

    const payload = {
      model: 'z-image',
      input: {
        prompt: truncatedPrompt,
        aspect_ratio: aspectRatio || '1:1'
      }
    };

    console.log(`📤 KIE.AI Z-Image request:`, {
      model: payload.model,
      aspectRatio
    });

    try {
      const kiePricingSync = require('./kie-pricing-sync');
      const kiePrice = kiePricingSync.getModelPriceSync('z_image');
      if (kiePrice) {
        console.log(`💰 KIE.AI Z-Image price: $${kiePrice}`);
      }
    } catch (err) {
    }

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Z-Image response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      const responseCode = createResponse?.data?.code;
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (responseCode === 500) {
        console.error('❌ KIE.AI Z-Image - Server Error 500:', createResponse?.data);
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes.',
          provider: 'kie-ai',
          serverError: true
        };
      }

      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${apiMsg || JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI Z-Image task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 600, 5000, 'Z-Image (KIE.AI)');

    const imageUrl = extractImageUrl(result);
    if (!imageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Z-Image Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateWithNanoBananaKieAI(prompt, imageInput = null, resolution = "2K", aspectRatio = "1:1") {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Nano Banana Pro');
    }

    const images = imageInput ? normalizeImageInput(imageInput, 8) : [];
    const isText2Img = images.length === 0;

    console.log(`🎨 KIE.AI Nano Banana Pro (${isText2Img ? 'text2img' : 'img2img'}):`, {
      prompt: prompt.substring(0, 100),
      resolution,
      aspectRatio,
      imageCount: images.length
    });

    // https://docs.kie.ai/market/google/nano-banana-pro
    const payload = {
      model: 'nano-banana-pro',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: {
        prompt: prompt,
        image_input: images,  
        aspect_ratio: aspectRatio || '1:1',
        resolution: resolution,  // "1K", "2K", "4K"
        output_format: 'png'
      }
    };

    console.log(`📤 KIE.AI Nano Banana request:`, {
      model: payload.model,
      mode: isText2Img ? 'text2img' : 'img2img',
      images: images.length,
      resolution,
      aspectRatio
    });

    try {
      const kiePricingSync = require('./kie-pricing-sync');
      let modelKey;
      if (resolution === '4K') {
        modelKey = 'nano_banana_4k';
      } else if (resolution === '2K') {
        modelKey = 'nano_banana_2k';
      } else {
        modelKey = 'nano_banana';  
      }
      const kiePrice = kiePricingSync.getModelPriceSync(modelKey);
      if (kiePrice) {
        console.log(`💰 KIE.AI price: $${kiePrice} (${resolution})`);
      }
    } catch (err) {
    }

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Nano Banana response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      const responseCode = createResponse?.data?.code;
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (responseCode === 500) {
        console.error('❌ KIE.AI Nano Banana - Server Error 500:', createResponse?.data);
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
          provider: 'kie-ai',
          serverError: true
        };
      }

      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${apiMsg || JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 600, 5000, 'Nano Banana Pro (KIE.AI)');

    const imageUrl = extractImageUrl(result);
    if (!imageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Nano Banana Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateWithSeedreamVariantKieAI({
  prompt,
  imageInput = null,
  aspectRatio = "1:1",
  quality = "basic",
  textModel,
  imageModel,
  modelLabel = 'Seedream',
  priceModelKey = null,
  maxImages = 14,
  maxPromptLengthText = null,
  maxPromptLengthImage = null
}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error(`Prompt is required for ${modelLabel}`);
    }

    // ✅ GUARD: Detect swapped parameters (aspectRatio got a resolution, quality got a ratio)
    const validAspectRatios = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'];
    const resolutionValues = ['2K', '4K', '2k', '4k', 'basic', 'high'];
    if (resolutionValues.includes(aspectRatio) || (!validAspectRatios.includes(aspectRatio) && validAspectRatios.includes(quality))) {
      console.warn(`⚠️ ${modelLabel}: SWAPPED params detected! aspectRatio='${aspectRatio}', quality='${quality}' → auto-swapping`);
      const tmp = aspectRatio;
      if (validAspectRatios.includes(quality)) {
        aspectRatio = quality;
      } else {
        aspectRatio = '1:1';
      }
      if (resolutionValues.includes(tmp)) {
        quality = (tmp === '4K' || tmp === '4k' || tmp === 'high') ? 'high' : 'basic';
      } else {
        quality = 'basic';
      }
      console.log(`✅ ${modelLabel}: Corrected → aspectRatio='${aspectRatio}', quality='${quality}'`);
    }

    if (!validAspectRatios.includes(aspectRatio)) {
      console.warn(`⚠️ ${modelLabel}: invalid aspectRatio '${aspectRatio}', falling back to '1:1'`);
      aspectRatio = '1:1';
    }

    if (quality !== 'basic' && quality !== 'high') {
      console.warn(`⚠️ ${modelLabel}: invalid quality '${quality}', falling back to 'basic'`);
      quality = 'basic';
    }

    const images = imageInput ? normalizeImageInput(imageInput, maxImages) : [];
    const isEdit = images.length > 0;
    const maxPromptLength = isEdit ? maxPromptLengthImage : maxPromptLengthText;
    const finalPrompt = (maxPromptLength && prompt.length > maxPromptLength)
      ? prompt.substring(0, maxPromptLength)
      : prompt;

    if (maxPromptLength && prompt.length > maxPromptLength) {
      console.warn(`⚠️ ${modelLabel}: prompt truncated from ${prompt.length} to ${maxPromptLength} chars`);
    }

    const modelName = isEdit ? imageModel : textModel;

    console.log(`🎨 KIE.AI ${modelLabel} (${isEdit ? 'edit/img2img' : 'text2img'}):`, {
      prompt: finalPrompt.substring(0, 100),
      aspectRatio,
      quality,
      imageCount: images.length
    });

    const input = {
      prompt: finalPrompt,
      aspect_ratio: aspectRatio || '1:1',
      quality
    };

    if (isEdit) {
      input.image_urls = images;
    }

    const payload = {
      model: modelName,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI ${modelLabel} request:`, {
      model: payload.model,
      mode: isEdit ? 'edit' : 'text2img',
      images: images.length
    });

    try {
      const kiePricingSync = require('./kie-pricing-sync');
      if (priceModelKey) {
        const kiePrice = kiePricingSync.getModelPriceSync(priceModelKey);
        if (kiePrice) {
          console.log(`💰 KIE.AI ${modelLabel} price: $${kiePrice}`);
        }
      }
    } catch (err) {
    }

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI ${modelLabel} response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      const responseCode = createResponse?.data?.code;
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (responseCode === 500) {
        console.error(`❌ KIE.AI ${modelLabel} - Server Error 500:`, createResponse?.data);
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
          provider: 'kie-ai',
          serverError: true
        };
      }

      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${apiMsg || JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 400, 3000, `${modelLabel} (KIE.AI)`);

    const imageUrl = extractImageUrl(result);
    if (!imageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error(`❌ KIE.AI ${modelLabel} Error:`, error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateWithSeedreamKieAI(prompt, imageInput = null, aspectRatio = "1:1", quality = "basic") {
  return generateWithSeedreamVariantKieAI({
    prompt,
    imageInput,
    aspectRatio,
    quality,
    textModel: 'seedream/4.5-text-to-image',
    imageModel: 'seedream/4.5-edit',
    modelLabel: 'Seedream 4.5',
    priceModelKey: 'seedream_4k'
  });
}


async function generateWithSeedream5LiteKieAI(prompt, imageInput = null, aspectRatio = "1:1", quality = "basic") {
  return generateWithSeedreamVariantKieAI({
    prompt,
    imageInput,
    aspectRatio,
    quality,
    textModel: 'seedream/5-lite-text-to-image',
    imageModel: 'seedream/5-lite-image-to-image',
    modelLabel: 'Seedream 5.0 Lite',
    priceModelKey: 'seedream_5_lite',
    maxPromptLengthText: 2995,
    maxPromptLengthImage: 2996
  });
}


async function generateWithStableDiffusionKieAI(prompt, imageInput = null, aspectRatio = "1:1") {
  return {
    success: false,
    error: 'Stable Diffusion is not supported on KIE.AI. Use Replicate instead.',
    provider: 'kie-ai',
    notSupported: true
  };
}


async function generateWithRecraftUpscaleKieAI(imageUrl) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!imageUrl) {
      throw new Error('Recraft Upscale requires an image');
    }

    console.log(`✨ KIE.AI Recraft Crisp Upscale`);

    const payload = {
      model: 'recraft/crisp-upscale',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: {
        image: imageUrl
      }
    };

    console.log(`📤 KIE.AI Recraft Upscale request`);

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Recraft response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 400, 3000, 'Recraft Upscale (KIE.AI)');

    const resultImageUrl = extractImageUrl(result);
    if (!resultImageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: resultImageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Recraft Upscale Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateWithIdeogramKieAI(imageUrl, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!imageUrl) {
      throw new Error('Ideogram requires an image');
    }

    const {
      mode = 'reframe',         // 'reframe', 'remix', 'edit'
      imageSize = 'square_hd',  // 'square_hd', 'landscape_hd', 'portrait_hd'
      renderingSpeed = 'TURBO',  
      style = 'AUTO',           // 'AUTO', 'REALISTIC', 'DESIGN', etc
      numImages = '1',          // '1' - '4'
      seed = 0,
      prompt = ''               
    } = options;

    const modelName = `ideogram/v3-${mode}`;

    console.log(`🎨 KIE.AI Ideogram v3 (${mode}):`, {
      imageSize,
      renderingSpeed,
      style,
      numImages
    });

    const input = {
      image_url: imageUrl,
      image_size: imageSize,
      rendering_speed: renderingSpeed,
      style: style,
      num_images: numImages,
      seed: seed
    };

    if (prompt && (mode === 'remix' || mode === 'edit')) {
      input.prompt = prompt;
    }

    const payload = {
      model: modelName,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Ideogram request:`, {
      model: payload.model,
      imageSize,
      renderingSpeed
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Ideogram response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      const responseCode = createResponse?.data?.code;
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (responseCode === 500) {
        console.error('❌ KIE.AI Ideogram - Server Error 500:', createResponse?.data);
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
          provider: 'kie-ai',
          serverError: true
        };
      }

      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${apiMsg || JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    const result = await pollJobStatus(taskId, 400, 3000, 'Ideogram (KIE.AI)');

    const resultImageUrl = extractImageUrl(result);
    if (!resultImageUrl) {
      throw new Error('KIE.AI returned no image in output');
    }

    return {
      success: true,
      imageUrl: resultImageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Ideogram Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}

// ==================== VIDEO GENERATION ====================


async function generateKlingMotionKieAI(prompt, imageUrl, videoUrl, mode = '720p', characterOrientation = 'image', options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!imageUrl || !videoUrl) {
      throw new Error('KIE.AI Kling Motion requires both an image and a video');
    }

    const [normalizedImageUrl, normalizedVideoUrl] = await Promise.all([
      cacheRemoteFileForKie(imageUrl, 'telegram-kling-motion-images'),
      cacheRemoteFileForKie(videoUrl, 'telegram-kling-motion-videos')
    ]);

    console.log(`🎥 KIE.AI Kling Motion Control:`, {
      prompt: prompt?.substring(0, 100) || 'no prompt',
      mode,
      characterOrientation
    });

    // https://docs.kie.ai/market/kling/motion-control
    const payload = {
      model: 'kling-2.6/motion-control',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: {
        prompt: prompt || '',
        input_urls: [normalizedImageUrl],
        video_urls: [normalizedVideoUrl],
        mode: mode,  
        character_orientation: characterOrientation  
      }
    };

    console.log(`📤 KIE.AI Kling Motion request:`, {
      model: payload.model,
      mode,
      orientation: characterOrientation
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Kling Motion response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    if (typeof options.onTaskCreated === 'function') {
      try {
        await options.onTaskCreated(taskId);
      } catch (e) {
        console.warn(`⚠️ onTaskCreated callback error: ${e.message}`);
      }
    }

    const result = await pollJobStatus(taskId, 600, 5000, 'Kling Motion (KIE.AI)');

    if (result && result._timeout) {
      console.warn(`⏱️ Kling Motion task ${taskId} still pending after timeout`);
      return { success: false, pending: true, taskId, provider: 'kie-ai' };
    }

    const videoResultUrl = extractVideoUrl(result);
    if (!videoResultUrl) {
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoResultUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Kling Motion Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateKling3VideoKieAI(options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    const {
      prompt = '',              
      imageUrls = [],           
      sound = true,             
      duration = '5',           // '3'-'15'
      aspectRatio = '16:9',     // '16:9', '9:16', '1:1'
      mode = 'pro',             
      multiShots = false,       // Multi-shot mode
      multiPrompt = [],         
      klingElements = [],       // Element references
      onTaskCreated = null
    } = options;

    if (!multiShots && !prompt) {
      throw new Error('Prompt is required for single-shot mode');
    }

    if (multiShots && (!multiPrompt || multiPrompt.length === 0)) {
      throw new Error('multiPrompt is required for multi-shot mode');
    }

    const normalizedImageUrls = await cacheRemoteFilesForKie(imageUrls, {
      maxItems: 2,
      uploadPath: 'telegram-kling-3-images'
    });
    const normalizedKlingElements = Array.isArray(klingElements)
      ? await Promise.all(
          klingElements.map(async (element) => ({
            ...element,
            imageUrls: await cacheRemoteFilesForKie(element?.imageUrls, {
              maxItems: 4,
              uploadPath: 'telegram-kling-3-elements'
            }),
            videoUrl: await cacheRemoteFileForKie(
              element?.videoUrl,
              'telegram-kling-3-element-videos'
            )
          }))
        )
      : [];

    console.log(`🎥 KIE.AI Kling 3.0 (${multiShots ? 'multi-shot' : 'single-shot'}):`, {
      prompt: prompt?.substring(0, 100) || 'multi-shot mode',
      duration,
      aspectRatio,
      mode,
      sound,
      multiShots,
      shots: multiPrompt?.length || 0,
      elements: normalizedKlingElements.length,
      hasImages: normalizedImageUrls.length
    });

    const input = {
      sound: multiShots ? true : Boolean(sound),
      duration: String(duration),
      mode: mode,
      multi_shots: multiShots
    };

    if (normalizedImageUrls.length === 0) {
      input.aspect_ratio = aspectRatio || '1:1';
    }

    // First/last frame images
    if (normalizedImageUrls.length > 0) {
      input.image_urls = normalizedImageUrls;
    }

    if (multiShots) {
      // Multi-shot mode
      input.multi_prompt = multiPrompt.map(shot => ({
        prompt: shot.prompt,
        duration: parseInt(shot.duration) || 3
      }));
      input.prompt = '';
    } else {
      // Single-shot mode
      input.prompt = prompt;
      input.multi_prompt = []; 
    }

    // Element references
    if (normalizedKlingElements.length > 0) {
      input.kling_elements = normalizedKlingElements.map(el => {
        const element = {
          name: el.name,
          description: el.description || el.name
        };

        if (el.imageUrls && el.imageUrls.length > 0) {
          element.element_input_urls = el.imageUrls;
        }

        if (el.videoUrl) {
          element.element_input_video_urls = [el.videoUrl];
        }

        return element;
      });
    }

    const payload = {
      model: 'kling-3.0/video',
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Kling 3.0 request:`, {
      model: payload.model,
      mode: input.mode,
      multiShots: input.multi_shots,
      duration: input.duration,
      sound: input.sound
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = createResponse?.data?.data;
    const taskId = data?.taskId;
    if (!taskId) {
      const responseCode = createResponse?.data?.code;
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (responseCode === 500) {
        console.error('❌ KIE.AI Kling 3.0 - Server Error 500:', createResponse?.data);
        console.error('📋 Request metadata for support:', {
          model: payload.model,
          duration: payload?.input?.duration,
          aspectRatio: payload?.input?.aspect_ratio
        });
        console.error('💡 Possible reasons: 1) Temporary server issue, 2) API parameters changed, 3) Invalid input values');
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue.\n\n' +
                 'Possible causes:\n' +
                 '• The KIE.AI server is overloaded\n' +
                 '• API changes\n' +
                 '• Invalid request parameters\n\n' +
                 'Try the following:\n' +
                 '1. Wait 1-2 minutes\n' +
                 '2. Try another model\n' +
                 '3. Contact support',
          provider: 'kie-ai',
          serverError: true,
          requestPayload: payload
        };
      }

      const errText = typeof apiMsg === 'string' ? apiMsg : (createResponse?.data ? JSON.stringify(createResponse.data) : 'KIE.AI did not return a taskId');
      console.error('❌ KIE.AI Kling 3.0 createTask: no taskId', createResponse?.data);
      console.error('📋 Request metadata for support:', {
        model: payload.model,
        duration: payload?.input?.duration,
        aspectRatio: payload?.input?.aspect_ratio
      });
      return {
        success: false,
        error: errText || 'The server did not return a task identifier. Please try again.',
        provider: 'kie-ai'
      };
    }
    console.log(`✅ KIE.AI Kling 3.0 task created`);
    console.log(`📋 Task ID for KIE.AI support: ${taskId}`);

    if (typeof onTaskCreated === 'function') {
      try {
        await onTaskCreated(taskId);
      } catch (e) {
        console.warn(`⚠️ onTaskCreated callback error: ${e.message}`);
      }
    }

    const result = await pollJobStatus(taskId, 600, 5000, 'Kling 3.0 (KIE.AI)');

    if (result && result._timeout) {
      console.warn(`⏱️ Kling 3.0 task ${taskId} still pending after timeout`);
      return { success: false, pending: true, taskId, provider: 'kie-ai', mode, multiShots };
    }

    const videoUrl = extractVideoUrl(result);
    if (!videoUrl) {
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      taskId: taskId,
      provider: 'kie-ai',
      mode: mode,
      multiShots: multiShots
    };

  } catch (error) {
    const res = error.response?.data;
    console.error('❌ KIE.AI Kling 3.0 Error:', res || error.message);

    if (res?.code === 500 || error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    const errMsg = (typeof res?.msg === 'string' ? res.msg : null) || res?.message || error.message;
    return {
      success: false,
      error: errMsg,
      provider: 'kie-ai'
    };
  }
}


async function generateKlingVideoKieAI(prompt, imageUrl = null, duration = '5', aspectRatio = '16:9', sound = false, version = 'v2.6', options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Kling');
    }

    const normalizedImageUrl = await cacheRemoteFileForKie(imageUrl, 'telegram-kling-images');
    const { tailImageUrl = '', negativePrompt = '', cfgScale = 0.5, onTaskCreated = null } = options;
    const normalizedTailImageUrl = await cacheRemoteFileForKie(tailImageUrl, 'telegram-kling-tail-images');
    const isImage2Video = !!normalizedImageUrl;

    let modelName;
    if (version === 'v2.5') {
      if (!imageUrl) {
        throw new Error('Kling v2.5 only supports image-to-video. Please upload a start image.');
      }
      modelName = 'kling/v2-5-turbo-image-to-video-pro';
    } else {
      // v2.6
      modelName = isImage2Video ? 'kling-2.6/image-to-video' : 'kling-2.6/text-to-video';
    }

    console.log(`🎥 KIE.AI Kling ${version} (${isImage2Video ? 'image2video' : 'text2video'}):`, {
      prompt: prompt.substring(0, 100),
      duration,
      aspectRatio,
      sound,
      hasImage: isImage2Video,
      hasTailImage: !!normalizedTailImageUrl
    });

    let input;

    if (version === 'v2.5') {
      input = {
        prompt: prompt,
        image_url: normalizedImageUrl || '',
        tail_image_url: normalizedTailImageUrl,
        duration: String(duration),
        negative_prompt: negativePrompt,
        cfg_scale: cfgScale
      };
    } else {
      input = {
        prompt: prompt,
        sound: sound,
        duration: String(duration)
      };

      if (!isImage2Video) {
        input.aspect_ratio = aspectRatio || '16:9';
      }

      if (isImage2Video) {
        input.image_urls = [normalizedImageUrl];
      }
    }

    const payload = {
      model: modelName,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Kling ${version} request:`, {
      model: payload.model,
      mode: isImage2Video ? 'image2video' : 'text2video',
      duration,
      sound,
      payload: JSON.stringify(payload, null, 2)
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI task created: ${taskId}`);

    if (typeof onTaskCreated === 'function') {
      try {
        await onTaskCreated(taskId);
      } catch (e) {
        console.warn(`⚠️ onTaskCreated callback error: ${e.message}`);
      }
    }

    const result = await pollJobStatus(taskId, 600, 5000, `Kling ${version} (KIE.AI)`);

    if (result && result._timeout) {
      console.warn(`⏱️ Kling ${version} task ${taskId} still pending after timeout`);
      return { success: false, pending: true, taskId, provider: 'kie-ai', version };
    }

    const videoUrl = extractVideoUrl(result);
    if (!videoUrl) {
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      taskId: taskId,
      provider: 'kie-ai',
      version: version
    };

  } catch (error) {
    console.error(`❌ KIE.AI Kling Error:`, {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      stack: error.stack
    });

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    let errorMessage = error.message;

    if (error.response?.data) {
      const apiError = error.response.data;
      if (apiError.msg) {
        errorMessage = apiError.msg;
      } else if (apiError.message) {
        errorMessage = apiError.message;
      } else if (apiError.error) {
        errorMessage = apiError.error;
      }
    }

    return {
      success: false,
      error: errorMessage,
      provider: 'kie-ai'
    };
  }
}


async function generateRunwayVideoKieAI(prompt, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Runway');
    }

    const {
      imageUrl = null,         
      duration = 5,            
      quality = '720p',        
      aspectRatio = '16:9',    // '16:9', '9:16', '1:1', '4:3', '3:4'
      waterMark = '',          
      callBackUrl = null,      // callback URL
      onTaskCreated = null
    } = options;
    const normalizedImageUrl = await cacheRemoteFileForKie(imageUrl, 'telegram-runway-images');

    if (quality === '1080p' && duration !== 5) {
      console.warn('⚠️ 1080p is available only for 5-second videos. Falling back to 720p.');
    }

    const actualQuality = (quality === '1080p' && duration !== 5) ? '720p' : quality;

    console.log(`🎬 KIE.AI Runway (${normalizedImageUrl ? 'image2video' : 'text2video'}):`, {
      prompt: prompt.substring(0, 100),
      duration,
      quality: actualQuality,
      aspectRatio,
      hasImage: !!normalizedImageUrl
    });

    // https://docs.kie.ai/runway-api/generate-ai-video
    const payload = {
      prompt: prompt,
      duration: duration,  
      quality: actualQuality,
      aspectRatio: aspectRatio,
      waterMark: waterMark
    };

    if (normalizedImageUrl) {
      payload.imageUrl = normalizedImageUrl;
    }

    // Callback URL
    if (callBackUrl) {
      payload.callBackUrl = callBackUrl;
    } else {
      payload.callBackUrl = `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai-runway`;
    }

    console.log(`📤 KIE.AI Runway request:`, {
      mode: normalizedImageUrl ? 'image2video' : 'text2video',
      duration,
      quality: actualQuality,
      aspectRatio
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/runway/generate`,  
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Runway response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      console.error('❌ Invalid KIE.AI Runway response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI Runway: ${JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI Runway task created: ${taskId}`);

    if (typeof onTaskCreated === 'function') {
      try {
        await onTaskCreated(taskId);
      } catch (e) {
        console.warn(`⚠️ onTaskCreated callback error: ${e.message}`);
      }
    }

    const result = await pollRunwayStatus(taskId, 600, 5000, 'Runway (KIE.AI)');

    if (result && result._timeout) {
      console.warn(`⏱️ Runway task ${taskId} still pending after timeout`);
      return { success: false, pending: true, taskId, provider: 'kie-ai', _runwayPending: true };
    }

    const videoUrl = result.videoInfo?.videoUrl;
    if (!videoUrl) {
      throw new Error('KIE.AI Runway returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      thumbnailUrl: result.videoInfo?.imageUrl,
      taskId: taskId,
      provider: 'kie-ai'
    };

  } catch (error) {
    console.error('❌ KIE.AI Runway Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function pollRunwayStatus(taskId, maxAttempts = 600, interval = 5000, modelName = 'Runway') {
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const response = await axios.get(
        `${KIE_API_BASE}/runway/record-detail?taskId=${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${KIE_API_KEY}`
          }
        }
      );

      const task = response.data.data;
      const state = task.state;

      console.log(`📊 ${modelName} status (attempt ${attempts + 1}): ${state}`);

      if (state === 'success') {
        return task;
      } else if (state === 'fail') {
        const errorMsg = task.failMsg || 'Unknown error';
        throw new Error(`Task failed: ${errorMsg}`);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;

    } catch (error) {
      if (error.message.includes('Task failed')) {
        throw error;
      }
      console.error(`⚠️ Polling error:`, error.message);

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    }
  }

  try {
    const last = await axios.get(`${KIE_API_BASE}/runway/record-detail?taskId=${taskId}`, {
      headers: { 'Authorization': `Bearer ${KIE_API_KEY}` }
    });
    const task = last.data?.data;
    if (task?.state === 'success') {
      console.log(`📊 ${modelName} got result on final check`);
      return task;
    }
  } catch (e) {  }

  console.warn(`⏱️ ${modelName} task ${taskId} timed out. Returning pending state.`);
  return { _timeout: true, taskId };
}


async function generateSora2KieAI(prompt, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Sora 2');
    }

    const {
      imageUrl = null,           
      duration = null,           
      aspectRatio = 'landscape',
      onTaskCreated = null
    } = options;
    const normalizedImageUrl = await cacheRemoteFileForKie(imageUrl, 'telegram-sora-images');
    const isImageToVideo = !!normalizedImageUrl;

    let modelName, actualDuration;
    if (isImageToVideo) {
      modelName = 'sora-2-image-to-video';
      actualDuration = duration || 15;  
    } else {
      modelName = 'sora-2-text-to-video';
      actualDuration = 15;  
    }

    console.log(`🌌 KIE.AI Sora 2 (${isImageToVideo ? 'image2video' : 'text2video'}):`, {
      prompt: prompt.substring(0, 100),
      duration: actualDuration,
      aspectRatio,
      hasImage: isImageToVideo
    });

    const input = {
      prompt: prompt,
      aspect_ratio: aspectRatio  
    };

    if (isImageToVideo) {
      input.image_urls = [normalizedImageUrl];
    }

    const payload = {
      model: modelName,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input: input
    };

    console.log(`📤 KIE.AI Sora 2 request:`, {
      model: payload.model,
      duration: actualDuration,
      aspectRatio,
      hasImage: isImageToVideo
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Sora 2 response:`, createResponse.data);

    if (!createResponse.data?.data?.taskId) {
      console.error('❌ Invalid KIE.AI Sora 2 response:', createResponse.data);
      throw new Error('No taskId in response');
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI Sora 2 task created: ${taskId}`);

    if (typeof onTaskCreated === 'function') {
      try {
        await onTaskCreated(taskId);
      } catch (e) {
        console.warn(`⚠️ onTaskCreated callback error: ${e.message}`);
      }
    }

    const result = await pollJobStatus(taskId, 120, 5000, 'Sora 2 (KIE.AI)');

    if (result && result._timeout) {
      console.warn(`⏱️ Sora 2 task ${taskId} still pending after timeout`);
      return { success: false, pending: true, taskId, provider: 'kie-ai', duration: actualDuration };
    }

    const videoResultUrl = extractVideoUrl(result);
    if (!videoResultUrl) {
      throw new Error('KIE.AI Sora 2 returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoResultUrl,
      taskId: taskId,
      provider: 'kie-ai',
      duration: actualDuration
    };

  } catch (error) {
    console.error('❌ KIE.AI Sora 2 Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateSeedanceVideoKieAI(prompt, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Seedance');
    }

    const {
      modelKey = 'seedance_2',
      referenceImageUrls = [],
      referenceVideoUrls = [],
      referenceAudioUrls = [],
      returnLastFrame = false,
      generateAudio = true,
      resolution = '480p',
      aspectRatio = '16:9',
      duration = 4,
      webSearch = false,
      onTaskCreated = null
    } = options;

    const apiModel = modelKey === 'seedance_2_fast'
      ? 'bytedance/seedance-2-fast'
      : 'bytedance/seedance-2';

    const safeDuration = Math.max(4, Math.min(15, Number(duration) || 4));
    const safeResolution = ['480p', '720p'].includes(resolution) ? resolution : '480p';
    const safeAspectRatio = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'].includes(aspectRatio)
      ? aspectRatio
      : '16:9';

    const input = {
      prompt,
      return_last_frame: !!returnLastFrame,
      generate_audio: !!generateAudio,
      resolution: safeResolution,
      aspect_ratio: safeAspectRatio,
      duration: safeDuration,
      web_search: !!webSearch
    };

    const [imageRefs, videoRefs, audioRefs] = await Promise.all([
      cacheRemoteFilesForKie(referenceImageUrls, {
        maxItems: 5,
        uploadPath: 'telegram-seedance-images'
      }),
      cacheRemoteFilesForKie(referenceVideoUrls, {
        maxItems: 3,
        uploadPath: 'telegram-seedance-videos'
      }),
      cacheRemoteFilesForKie(referenceAudioUrls, {
        maxItems: 3,
        uploadPath: 'telegram-seedance-audio'
      })
    ]);

    if (imageRefs.length > 0) input.reference_image_urls = imageRefs;
    if (videoRefs.length > 0) input.reference_video_urls = videoRefs;
    if (audioRefs.length > 0) input.reference_audio_urls = audioRefs;

    const payload = {
      model: apiModel,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`,
      input
    };

    console.log(`🎥 KIE.AI Seedance request (${modelKey}):`, {
      prompt: prompt.substring(0, 100),
      resolution: safeResolution,
      aspectRatio: safeAspectRatio,
      duration: safeDuration,
      generateAudio: !!generateAudio,
      refs: {
        images: imageRefs.length,
        videos: videoRefs.length,
        audio: audioRefs.length
      }
    });

    const createResponse = await axios.post(
      `${KIE_API_BASE}/jobs/createTask`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Seedance response:`, createResponse.data);

    if (!createResponse.data?.data?.taskId) {
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (createResponse?.data?.code === 500) {
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes.',
          provider: 'kie-ai',
          serverError: true
        };
      }

      console.error('❌ Invalid KIE.AI Seedance response:', createResponse.data);
      throw new Error(apiMsg || 'No taskId in response');
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI Seedance task created: ${taskId}`);

    if (typeof onTaskCreated === 'function') {
      try {
        await onTaskCreated(taskId);
      } catch (e) {
        console.warn(`⚠️ onTaskCreated callback error: ${e.message}`);
      }
    }

    const result = await pollJobStatus(taskId, 720, 5000, `${modelKey} (KIE.AI)`);

    if (result && result._timeout) {
      console.warn(`⏱️ Seedance task ${taskId} still pending after timeout`);
      return {
        success: false,
        pending: true,
        taskId,
        provider: 'kie-ai',
        model: apiModel,
        duration: safeDuration,
        resolution: safeResolution
      };
    }

    const videoUrl = extractVideoUrl(result);
    if (!videoUrl) {
      throw new Error('KIE.AI Seedance returned no video in output');
    }

    return {
      success: true,
      videoUrl,
      taskId,
      provider: 'kie-ai',
      model: apiModel,
      duration: safeDuration,
      resolution: safeResolution
    };
  } catch (error) {
    console.error('❌ KIE.AI Seedance Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function generateVeoKieAI(prompt, options = {}) {
  try {
    if (!KIE_API_KEY) {
      throw new Error('KIE_AI_API_KEY is not set in .env');
    }

    if (!prompt) {
      throw new Error('Prompt is required for Veo');
    }

    const {
      imageUrls = [],           
      model = 'veo3_fast',      
      aspectRatio = '16:9',     // '16:9', '9:16', 'Auto'
      generationType = null,    // TEXT_2_VIDEO, FIRST_AND_LAST_FRAMES_2_VIDEO, REFERENCE_2_VIDEO
      enableTranslation = true, 
      watermark = null,         
      seeds = null              // random seed 10000-99999
    } = options;
    const normalizedImageUrls = await cacheRemoteFilesForKie(imageUrls, {
      maxItems: 3,
      uploadPath: 'telegram-veo-images'
    });

    let actualGenerationType = generationType;
    if (!actualGenerationType) {
      if (normalizedImageUrls.length === 0) {
        actualGenerationType = 'TEXT_2_VIDEO';
      } else if (normalizedImageUrls.length <= 2) {
        actualGenerationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO';
      } else {
        actualGenerationType = 'REFERENCE_2_VIDEO';
      }
    }

    if (actualGenerationType === 'REFERENCE_2_VIDEO') {
      if (model !== 'veo3_fast') {
        console.warn('⚠️ REFERENCE_2_VIDEO supports only veo3_fast. Switching the model automatically.');
      }
      if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
        console.warn('⚠️ REFERENCE_2_VIDEO supports only 16:9 and 9:16 aspect ratios');
      }
    }

    console.log(`🎥 KIE.AI Veo 3.1 (${actualGenerationType}):`, {
      prompt: prompt.substring(0, 100),
      model,
      aspectRatio,
      generationType: actualGenerationType,
      imageCount: normalizedImageUrls.length,
      enableTranslation
    });

    // https://docs.kie.ai/market/google/veo-3.1
    const payload = {
      prompt: prompt,
      model: actualGenerationType === 'REFERENCE_2_VIDEO' ? 'veo3_fast' : model,
      aspect_ratio: aspectRatio,
      generationType: actualGenerationType,
      enableTranslation: enableTranslation,
      callBackUrl: `${process.env.APP_URL || 'http://localhost:5500'}/webhook/kie-ai`
    };

    if (normalizedImageUrls.length > 0) {
      payload.imageUrls = normalizedImageUrls;
    }

    if (watermark) {
      payload.watermark = watermark;
    }

    if (seeds && seeds >= 10000 && seeds <= 99999) {
      payload.seeds = seeds;
    }

    console.log(`📤 KIE.AI Veo request:`, {
      model: payload.model,
      generationType: payload.generationType,
      aspectRatio: payload.aspect_ratio,
      images: payload.imageUrls?.length || 0,
      callBackUrl: payload.callBackUrl
    });

    console.log(`📤 KIE.AI Veo request metadata: ${JSON.stringify({
      model: payload.model,
      generationType: payload?.input?.generationType,
      aspectRatio: payload?.input?.aspectRatio,
      duration: payload?.input?.duration
    })}`);

    const createResponse = await axios.post(
      `${KIE_API_BASE}/veo/generate`,  
      payload,
      {
        headers: {
          'Authorization': `Bearer ${KIE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📥 KIE.AI Veo response:`, JSON.stringify(createResponse.data, null, 2));

    if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
      const responseCode = createResponse?.data?.code;
      const apiMsg = createResponse?.data?.msg ?? createResponse?.data?.message ?? '';

      if (responseCode === 500) {
        console.error('❌ KIE.AI Veo - Server Error 500:', createResponse?.data);
        return {
          success: false,
          error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
          provider: 'kie-ai',
          serverError: true
        };
      }

      console.error('❌ Invalid KIE.AI Veo response structure:', createResponse.data);
      throw new Error(`Unexpected response from KIE.AI Veo: ${apiMsg || JSON.stringify(createResponse.data)}`);
    }

    const taskId = createResponse.data.data.taskId;
    console.log(`✅ KIE.AI Veo task created: ${taskId}`);

    if (options.onTaskCreated) {
      try {
        options.onTaskCreated(taskId);
      } catch (e) {
        console.warn(`⚠️ onTaskCreated callback error: ${e.message}`);
      }
    }

    const result = await pollVeoStatus(taskId, 720, 5000, 'Veo 3.1 (KIE.AI)');

    console.log(`📋 Veo pollVeoStatus returned: _timeout=${!!result?._timeout}, type=${typeof result}, keys=${result ? Object.keys(result).join(',') : 'null'}`);

    if (result && result._timeout) {
      console.warn(`⏱️ Veo task ${taskId} still pending after timeout — returning pending state`);
      return {
        success: false,
        pending: true,
        taskId: taskId,
        provider: 'kie-ai',
        model: payload.model
      };
    }

    let videoUrl = extractVideoUrl(result);
    console.log(`📹 Veo extractVideoUrl result: ${videoUrl ? videoUrl.substring(0, 150) : 'NULL'}`);

    if (!videoUrl) {
      console.log(`🔄 Veo: extractVideoUrl returned null, trying get-1080p-video fallback... taskId=${taskId}`);
      videoUrl = await fetchVeo1080pUrl(taskId);
      if (!videoUrl) {
        console.log(`⏳ Veo: 1080p not ready yet, waiting 90s before retry... taskId=${taskId}`);
        await new Promise(r => setTimeout(r, 90000));
        videoUrl = await fetchVeo1080pUrl(taskId);
      }
      if (!videoUrl) {
        console.log(`⏳ Veo: 1080p still not ready, waiting 60s more... taskId=${taskId}`);
        await new Promise(r => setTimeout(r, 60000));
        videoUrl = await fetchVeo1080pUrl(taskId);
      }
      if (!videoUrl) {
        console.log(`⏳ Veo: 1080p STILL not ready, last try in 60s... taskId=${taskId}`);
        await new Promise(r => setTimeout(r, 60000));
        videoUrl = await fetchVeo1080pUrl(taskId);
      }
    }

    if (!videoUrl) {
      console.error(`❌ Veo: no video URL after all methods for taskId=${taskId}. Result keys: ${Object.keys(result).join(',')}`);
      console.error(`❌ Veo FULL result dump: ${JSON.stringify(result).substring(0, 2000)}`);
      if (result.info) console.error(`❌ Veo info: ${JSON.stringify(result.info).substring(0, 500)}`);
      if (result.response) console.error(`❌ Veo response: ${JSON.stringify(result.response).substring(0, 500)}`);
      if (result.resultJson) console.error(`❌ Veo resultJson: ${String(result.resultJson).substring(0, 500)}`);
      throw new Error('KIE.AI returned no video in output');
    }

    return {
      success: true,
      videoUrl: videoUrl,
      taskId: taskId,
      provider: 'kie-ai',
      model: payload.model,
      generationType: actualGenerationType
    };

  } catch (error) {
    console.error('❌ KIE.AI Veo Error:', error.response?.data || error.message);

    if (error.response?.data?.code === 500) {
      return {
        success: false,
        error: '⚠️ Temporary KIE.AI server issue. Try again in 1-2 minutes or contact support.',
        provider: 'kie-ai',
        serverError: true
      };
    }

    return {
      success: false,
      error: error.response?.data?.msg || error.response?.data?.message || error.message,
      provider: 'kie-ai'
    };
  }
}


async function pollVeoStatus(taskId, maxAttempts = 720, interval = 5000, modelName = 'Veo') {
  let attempts = 0;
  console.log(`🔁 ${modelName}: Starting polling for taskId=${taskId}, maxAttempts=${maxAttempts}, interval=${interval}ms (max ~${Math.round(maxAttempts * interval / 60000)}min)`);

  while (attempts < maxAttempts) {
    try {
      const job = await fetchVeoTaskInfo(taskId);
      if (!job) {
        if (attempts < 5 || attempts % 12 === 0) {
          console.log(`📊 ${modelName} poll (${attempts + 1}/${maxAttempts}): fetchVeoTaskInfo returned null`);
        }
        await new Promise(resolve => setTimeout(resolve, interval));
        attempts++;
        continue;
      }

      const state = (job.state || job.status || '').toLowerCase();

      if (attempts < 10 || attempts % 12 === 0 || state === 'success' || state === 'completed' || state === 'fail' || state === 'failed') {
        console.log(`📊 ${modelName} poll (${attempts + 1}/${maxAttempts}): state=${state || 'EMPTY'}, successFlag=${job.successFlag}, completeTime=${job.completeTime || 'null'}, hasResponse=${!!job.response}, hasInfo=${!!job.info}, hasResultJson=${!!job.resultJson}, errorMessage=${job.errorMessage || 'null'}`);
      }

      if (state === 'success' || state === 'completed') {
        console.log(`✅ ${modelName} task ${taskId} completed! Full result keys: ${Object.keys(job).join(',')}`);
        console.log(`✅ ${modelName} task ${taskId} FULL DATA: ${JSON.stringify(job).substring(0, 2000)}`);
        const testUrl = extractVideoUrl(job);
        console.log(`📹 ${modelName} extracted video URL: ${testUrl ? testUrl.substring(0, 150) : 'NULL'}`);
        return job;
      }
      if (state === 'fail' || state === 'failed' || state === 'error') {
        const errorMsg = job.failMsg || job.failCode || job.errorMessage || job.error || 'Unknown error';
        console.error(`❌ ${modelName} task ${taskId} FAILED: ${errorMsg}`);
        console.error(`❌ ${modelName} FULL fail data: ${JSON.stringify(job).substring(0, 1000)}`);
        throw new Error(`Task failed: ${errorMsg}`);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    } catch (error) {
      if (error.response?.status === 404) {
        console.warn(`⚠️ Task ${taskId} not found, retrying...`);
      } else if (error.message.includes('Task failed')) {
        throw error;
      } else {
        console.error(`⚠️ Polling error:`, error.message);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
      attempts++;
    }
  }

  try {
    const job = await fetchVeoTaskInfo(taskId);
    const state = (job?.state || job?.status || '').toLowerCase();
    if (state === 'success' || state === 'completed') {
      console.log(`📊 ${modelName} got result on final check`);
      const testUrl = extractVideoUrl(job);
      console.log(`📹 ${modelName} final check extracted URL: ${testUrl ? testUrl.substring(0, 100) : 'NULL'}`);
      return job;
    }
  } catch (e) {  }

  console.warn(`⏱️ ${modelName} task ${taskId} timed out after ${maxAttempts} attempts. Returning pending state.`);
  return { _timeout: true, taskId };
}


// ==================== EXPORT ====================


function getModelInfo(modelKey) {
  try {
    const fs = require('fs');
    const path = require('path');
    const cacheFile = path.join(__dirname, '../config/kie-ai-pricing-cache.json');

    if (!fs.existsSync(cacheFile)) {
      console.warn('⚠️ KIE.AI pricing cache not found');
      return null;
    }

    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

    const allPricing = cache.pricing?.all || [];
    const model = allPricing.find(m =>
      m.anchor?.includes(`model=${modelKey}`) ||
      m.modelDescription?.toLowerCase().includes(modelKey.toLowerCase())
    );

    if (!model) {
      console.warn(`⚠️ Model ${modelKey} not found in pricing cache`);
      return null;
    }

    const apiCost = parseFloat(model.usdPrice) || 0;
    const cost = Math.ceil(apiCost * 1.65 / 0.01); 

    return {
      cost,
      apiCost,
      creditPrice: model.creditPrice,
      modelDescription: model.modelDescription
    };

  } catch (error) {
    console.error('❌ Error loading model info:', error.message);
    return null;
  }
}

module.exports = {
  isAdminUser,

  generateWithNanoBananaBaseKieAI,   // ✅ Nano Banana (Base)
  generateWithNanoBananaKieAI,
  generateWithSeedreamKieAI,
  generateWithSeedream5LiteKieAI,
  generateWithStableDiffusionKieAI,  
  generateWithIdeogramKieAI,         // ✅ Ideogram v3
  generateWithRecraftUpscaleKieAI,   // ✅ Recraft Crisp Upscale
  generateWithZImageKieAI,           // ✅ Z-Image (Qwen)

  generateKlingMotionKieAI,          // ✅ Kling Motion Control
  generateKling3VideoKieAI,          // ✅ Kling 3.0 (multi-shot, element refs)
  generateKlingVideoKieAI,           // ✅ Kling v2.5 + v2.6
  generateRunwayVideoKieAI,          // ✅ Runway (endpoint: /runway/generate)
  generateSora2KieAI,                
  generateSeedanceVideoKieAI,        // ✅ Seedance 2 / Seedance 2 Fast
  generateVeoKieAI,                  // ✅ Veo 3.1 (endpoint: /veo/generate)

  getModelInfo,
  fetchTaskRecordInfoExported: fetchTaskRecordInfo,
  fetchVeoTaskInfoExported: fetchVeoTaskInfo,
  fetchVeo1080pUrlExported: fetchVeo1080pUrl,
  extractVideoUrlExported: extractVideoUrl,
  fetchRunwayTaskInfoExported: async (taskId) => {
    const response = await axios.get(
      `${KIE_API_BASE}/runway/record-detail?taskId=${taskId}`,
      { headers: { 'Authorization': `Bearer ${KIE_API_KEY}` } }
    );
    return response.data?.data || null;
  },
  KIE_API_BASE,
  KIE_API_KEY: !!KIE_API_KEY,
  isKieAIEnabled: !!KIE_API_KEY,

  SUPPORTED_MODELS: {
    image: [
      'nano_banana',      
      'nano_banana_2k',   
      'nano_banana_4k',   
      'seedream_4k',      // ✅ seedream/4.5-text-to-image, seedream/4.5-edit
      'seedream_5_lite',  // ✅ seedream/5-lite-text-to-image, seedream/5-lite-image-to-image
      'ideogram',         // ✅ ideogram/v3-reframe, v3-remix, v3-edit
      'recraft_upscale',  // ✅ recraft/crisp-upscale
      'z_image'           // ✅ z-image (Qwen)
    ],
    video: [
      'kling',            // ✅ kling/v2-5-turbo-image-to-video-pro
      'kling_v2_6',       // ✅ kling-2.6/text-to-video, kling-2.6/image-to-video
      'kling_3',          // ✅ kling-3.0/video (multi-shot, element refs) 🆕
      'kling_motion',     // ✅ kling-2.6/motion-control
      'runway_turbo',     // ✅ /runway/generate (endpoint!)
      'veo',              // ✅ veo3, veo3_fast (/veo/generate endpoint!)
      'seedance_2',
      'seedance_2_fast'
    ],
    kieAIOnly: [
      'kling_3',           
      'seedance_2',        // ⚠️ Seedance 2 - KIE only
      'seedance_2_fast',   // ⚠️ Seedance 2 Fast - KIE only
      'seedream_5_lite',   // ⚠️ Seedream 5.0 Lite - KIE.AI only
      'z_image'            
    ],
    notSupported: [
      'stable_diffusion', 
      'clarity',          
      'sora_2'            
    ]
  },

  
  isKieAIImplemented(modelKey) {
    const img = this.SUPPORTED_MODELS.image.includes(modelKey);
    const vid = this.SUPPORTED_MODELS.video.includes(modelKey);
    const not = this.SUPPORTED_MODELS.notSupported.includes(modelKey);
    return (img || vid) && !not;
  },

  MODEL_MAPPING: {
    // Image
    nano_banana: { model: 'google/nano-banana' },  // Base model
    nano_banana_2k: { model: 'nano-banana-pro', resolution: '2K' },
    nano_banana_4k: { model: 'nano-banana-pro', resolution: '4K' },
    seedream_4k: { model: 'seedream/4.5-text-to-image', edit: 'seedream/4.5-edit' },
    seedream_5_lite: { model: 'seedream/5-lite-text-to-image', edit: 'seedream/5-lite-image-to-image' },
    ideogram: { model: 'ideogram/v3-reframe', remix: 'ideogram/v3-remix', edit: 'ideogram/v3-edit' },
    recraft_upscale: { model: 'recraft/crisp-upscale' },
    z_image: { model: 'z-image' },

    // Video
    kling: { model: 'kling/v2-5-turbo-image-to-video-pro' },
    kling_v2_6: { model: 'kling-2.6/text-to-video', image: 'kling-2.6/image-to-video' },
    kling_3: { model: 'kling-3.0/video', features: ['multi-shot', 'element-refs'] },
    kling_motion: { model: 'kling-2.6/motion-control' },
    runway_turbo: { endpoint: '/runway/generate', quality: ['720p', '1080p'] },
    veo: { model: 'veo3_fast', quality: 'veo3', endpoint: '/veo/generate' },
    seedance_2: { model: 'bytedance/seedance-2' },
    seedance_2_fast: { model: 'bytedance/seedance-2-fast' }
  },

  SPECIAL_ENDPOINTS: {
    runway: '/runway/generate',
    runway_status: '/runway/record-detail',
    veo: '/veo/generate',
    jobs: '/jobs/createTask',
    jobs_recordInfo: '/jobs/recordInfo'
  }
};
