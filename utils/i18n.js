const messages = {
  en: require('../locales/en')
};

const DEFAULT_LOCALE = 'en';

function normalizeLocale(locale) {
  if (!locale || typeof locale !== 'string') {
    return DEFAULT_LOCALE;
  }

  const normalized = locale.toLowerCase().replace('_', '-');
  const baseLocale = normalized.split('-')[0];

  if (messages[normalized]) {
    return normalized;
  }

  if (messages[baseLocale]) {
    return baseLocale;
  }

  return DEFAULT_LOCALE;
}

function resolveLocale(localeSource) {
  if (!localeSource) {
    return DEFAULT_LOCALE;
  }

  if (typeof localeSource === 'string') {
    return normalizeLocale(localeSource);
  }

  const ctxLocale = localeSource.from?.language_code
    || localeSource.languageCode
    || localeSource.locale;

  return normalizeLocale(ctxLocale);
}

function getMessage(locale, key) {
  const resolvedLocale = resolveLocale(locale);
  const parts = key.split('.');

  let current = messages[resolvedLocale] || messages[DEFAULT_LOCALE];
  for (const part of parts) {
    current = current?.[part];
  }

  if (current != null) {
    return current;
  }

  let fallback = messages[DEFAULT_LOCALE];
  for (const part of parts) {
    fallback = fallback?.[part];
  }

  return fallback;
}

function formatMessage(template, params = {}) {
  if (typeof template !== 'string') {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    return value == null ? '' : String(value);
  });
}

function t(localeSource, key, params = {}) {
  const message = getMessage(localeSource, key);
  if (message == null) {
    return key;
  }

  return formatMessage(message, params);
}

module.exports = {
  DEFAULT_LOCALE,
  resolveLocale,
  t
};
