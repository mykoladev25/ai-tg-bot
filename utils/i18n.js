const messages = {
  en: require('../locales/en'),
  uk: require('../locales/uk')
};

const DEFAULT_LOCALE = 'en';
const LOCALE_ALIASES = {
  ua: 'uk',
  'uk-ua': 'uk'
};

function normalizeLocale(locale) {
  if (!locale || typeof locale !== 'string') {
    return DEFAULT_LOCALE;
  }

  const normalized = locale.toLowerCase().replace('_', '-');
  const aliasedLocale = LOCALE_ALIASES[normalized] || normalized;
  const baseLocale = aliasedLocale.split('-')[0];
  const aliasedBaseLocale = LOCALE_ALIASES[baseLocale] || baseLocale;

  if (messages[aliasedLocale]) {
    return aliasedLocale;
  }

  if (messages[aliasedBaseLocale]) {
    return aliasedBaseLocale;
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

function pickLocalizedText(localeSource, localizedText = {}) {
  const resolvedLocale = resolveLocale(localeSource);

  if (localizedText[resolvedLocale] != null) {
    return localizedText[resolvedLocale];
  }

  const baseLocale = resolvedLocale.split('-')[0];
  if (localizedText[baseLocale] != null) {
    return localizedText[baseLocale];
  }

  if (localizedText[DEFAULT_LOCALE] != null) {
    return localizedText[DEFAULT_LOCALE];
  }

  const firstAvailable = Object.values(localizedText).find((value) => value != null);
  return firstAvailable == null ? '' : firstAvailable;
}

function getAssistantLanguageInstruction(localeSource) {
  return pickLocalizedText(localeSource, {
    uk: 'Respond in Ukrainian by default because the user interface language is Ukrainian. Only switch languages if the user explicitly asks for another language.',
    en: 'Respond in English by default because the user interface language is English. Only switch languages if the user explicitly asks for another language.'
  });
}

function getDateLocale(localeSource) {
  return pickLocalizedText(localeSource, {
    uk: 'uk-UA',
    en: 'en-US'
  });
}

module.exports = {
  DEFAULT_LOCALE,
  getAssistantLanguageInstruction,
  getDateLocale,
  pickLocalizedText,
  resolveLocale,
  t
};
