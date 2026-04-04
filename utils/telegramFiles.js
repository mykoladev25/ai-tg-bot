const crypto = require('crypto');

const DEFAULT_PROXY_TTL_SECONDS = 10 * 60;

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

function isExpired(expiresAt) {
  const expires = parseInt(expiresAt, 10);
  if (!Number.isFinite(expires)) {
    return true;
  }

  return expires < Math.floor(Date.now() / 1000);
}

module.exports = {
  DEFAULT_PROXY_TTL_SECONDS,
  buildTelegramFileProxyUrl,
  getTelegramBotToken,
  getTelegramFileUrl,
  isExpired,
  verifyProxySignature
};
