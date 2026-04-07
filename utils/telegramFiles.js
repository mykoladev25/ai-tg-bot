const crypto = require('crypto');
const axios = require('axios');

const DEFAULT_PROXY_TTL_SECONDS = 10 * 60;
const DEFAULT_PROVIDER_PROXY_TTL_SECONDS = 24 * 60 * 60;

function getTelegramBotToken() {
  return process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
}

function getTelegramFileUrl(filePath) {
  const botToken = getTelegramBotToken();
  if (!botToken) {
    throw new Error('BOT_TOKEN is not configured');
  }

  if (!filePath) {
    throw new Error('Telegram file path is required');
  }

  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

function getFileProxySecret() {
  return process.env.FILE_PROXY_SECRET || getTelegramBotToken();
}

function extractTelegramFilePathFromProxyUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(fileUrl);
    const marker = '/telegram/file/';
    const pathIndex = parsed.pathname.indexOf(marker);

    if (pathIndex === -1) {
      return null;
    }

    const encodedPath = parsed.pathname.slice(pathIndex + marker.length);
    if (!encodedPath) {
      return null;
    }

    return decodeURIComponent(encodedPath);
  } catch (error) {
    return null;
  }
}

function extractTelegramFileIdFromProxyUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(fileUrl);
    const marker = '/telegram/file-id/';
    const pathIndex = parsed.pathname.indexOf(marker);

    if (pathIndex === -1) {
      return null;
    }

    const encodedFileId = parsed.pathname.slice(pathIndex + marker.length);
    if (!encodedFileId) {
      return null;
    }

    return decodeURIComponent(encodedFileId);
  } catch (error) {
    return null;
  }
}

function resolveServerSideTelegramFileUrl(fileUrl) {
  const filePath = extractTelegramFilePathFromProxyUrl(fileUrl);
  if (!filePath) {
    return fileUrl;
  }

  return getTelegramFileUrl(filePath);
}

async function resolveServerSideTelegramFileUrlAsync(fileUrl) {
  const filePath = extractTelegramFilePathFromProxyUrl(fileUrl);
  if (filePath) {
    return getTelegramFileUrl(filePath);
  }

  const fileId = extractTelegramFileIdFromProxyUrl(fileUrl);
  if (!fileId) {
    return fileUrl;
  }

  const botToken = getTelegramBotToken();
  if (!botToken) {
    throw new Error('BOT_TOKEN is not configured');
  }

  const response = await axios.get(`https://api.telegram.org/bot${botToken}/getFile`, {
    params: { file_id: fileId },
    timeout: 30000
  });

  const resolvedFilePath = response?.data?.result?.file_path;
  if (!resolvedFilePath) {
    throw new Error('Telegram getFile returned no file_path');
  }

  return getTelegramFileUrl(resolvedFilePath);
}

function signProxyPayload(filePath, expiresAt) {
  const secret = getFileProxySecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`${filePath}:${expiresAt}`)
    .digest('hex');
}

function verifyProxySignature(filePath, expiresAt, signature) {
  if (!filePath || !expiresAt || !signature) {
    return false;
  }

  const expectedSignature = signProxyPayload(filePath, expiresAt);
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

function signFileIdProxyPayload(fileId, expiresAt) {
  const secret = getFileProxySecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`file-id:${fileId}:${expiresAt}`)
    .digest('hex');
}

function verifyFileIdProxySignature(fileId, expiresAt, signature) {
  if (!fileId || !expiresAt || !signature) {
    return false;
  }

  const expectedSignature = signFileIdProxyPayload(fileId, expiresAt);
  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

function buildTelegramFileProxyUrl(filePath, options = {}) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    return getTelegramFileUrl(filePath);
  }

  const ttlSeconds = Number.isFinite(options.ttlSeconds)
    ? options.ttlSeconds
    : DEFAULT_PROXY_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = signProxyPayload(filePath, expiresAt);
  const encodedPath = encodeURIComponent(filePath);

  return `${appUrl.replace(/\/$/, '')}/telegram/file/${encodedPath}?expires=${expiresAt}&signature=${signature}`;
}

function buildTelegramFileIdProxyUrl(fileId, options = {}) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    throw new Error('APP_URL is required to build Telegram file ID proxy URLs');
  }

  if (!fileId) {
    throw new Error('Telegram file ID is required');
  }

  const ttlSeconds = Number.isFinite(options.ttlSeconds)
    ? options.ttlSeconds
    : DEFAULT_PROVIDER_PROXY_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = signFileIdProxyPayload(fileId, expiresAt);
  const encodedFileId = encodeURIComponent(fileId);

  return `${appUrl.replace(/\/$/, '')}/telegram/file-id/${encodedFileId}?expires=${expiresAt}&signature=${signature}`;
}

function isExpired(expiresAt) {
  const expires = parseInt(expiresAt, 10);
  if (!Number.isFinite(expires)) {
    return true;
  }

  return expires < Math.floor(Date.now() / 1000);
}

module.exports = {
  DEFAULT_PROXY_TTL_SECONDS,
  DEFAULT_PROVIDER_PROXY_TTL_SECONDS,
  buildTelegramFileIdProxyUrl,
  buildTelegramFileProxyUrl,
  extractTelegramFileIdFromProxyUrl,
  extractTelegramFilePathFromProxyUrl,
  getTelegramBotToken,
  getTelegramFileUrl,
  isExpired,
  resolveServerSideTelegramFileUrl,
  resolveServerSideTelegramFileUrlAsync,
  verifyFileIdProxySignature,
  verifyProxySignature
};
