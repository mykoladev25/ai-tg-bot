module.exports = {
  common: {
    home: '🏠 Main menu',
    back: '← Back',
    cancel: 'Cancel',
    confirm: 'Confirm',
    yes: '✅ Yes',
    no: '❌ No',
    loading: 'Loading...',
    community: '👥 Community',
    buyTokens: '💰 Buy tokens',
    legalInfo: '📋 Legal information',
    providerChoice: '⚙️ Provider selection'
  },
  menu: {
    topUpBalance: '💰 Top up balance',
    creatives: '🎨 Creatives',
    video: '🎬 Video',
    images: '🖼️ Images',
    profile: '👤 Profile',
    assistants: '🧠 Assistants',
    feedback: '📝 Feedback',
    settings: '⚙️ Settings',
    help: '❓ Help'
  },
  sections: {
    assistantsTitle: '🧠 Gemini',
    assistantsPrompt: '💎 Gemini 3.1 Pro Preview delivers premium-quality responses.\n\nChoose a mode below 👇',
    videoTitle: '🎬 Video creation',
    videoPrompt: 'Choose a video workflow below 👇',
    imagesTitle: '🎨 AI design',
    imagesPrompt: 'Choose an image workflow below 👇',
    audioTitle: '🎙️ AI audio',
    audioPrompt: 'Choose an audio workflow below 👇',
    creativesTitle: '🎨 <b>Creative presets</b>',
    creativesPrompt: 'Choose a preset and the bot will generate a photoshoot with built-in prompts 👇'
  },
  payment: {
    telegramStars: '💫 Telegram Stars ({price}⭐)',
    wayforpay: '💳 WayForPay (Card/Apple/Google)'
  },
  legal: {
    terms: '📋 Terms of service',
    privacy: '🔒 Privacy policy',
    company: 'ℹ️ Company information'
  },
  subscription: {
    title: '⚡ Buy tokens\n\nChoose a package below.',
    starter: '🚀 STARTER',
    basic: '💎 BASIC',
    pro: '🔥 PRO',
    premium: '👑 PREMIUM',
    starterTest: '🧪 TEST 10⭐',
    packageTitle: '⚡ <b>{planName} package</b> — ${priceUSD}',
    accessAllModels: '💎 Access to all models',
    tokensDoNotExpire: '⏰ Tokens do not expire',
    mixAndMatch: '✨ Mix and match however you want!',
    savingsComparedStarter: '🔥 <b>Save {savingsPercent}%</b> compared to STARTER!',
    priceLine: '💰 <b>Price:</b> ${priceUSD} — {tokens}⚡ tokens',
    starsIntro: '<i>You can also pay with Telegram Stars:</i>',
    starsLine: '⭐ {starsPrice}⭐ — {tokens}⚡ tokens',
    biggerValue: '💡 <i>The larger the package, the better the value.</i>',
    choosePaymentMethod: '📱 Choose a payment method below 👇'
  },
  errors: {
    menuLoad: '⚠️ Failed to load the menu.\n\nPlease try again or contact the administrator.',
    selectModelFirst: 'Please choose a model from the menu first 👇',
    generic: '❌ Something went wrong. Please try again.',
    genericSupport: '❌ Something went wrong. Please try again or contact support. {supportUsername}',
    planNotFound: '❌ Plan not found',
    accessDenied: '❌ Access denied'
  },
  help: {
    quick: '❓ Use /help to view available commands\n📄 Guide: /instruction'
  },
  assistants: {
    textActivated: [
      '✍️ Gemini mode activated! 💎',
      '',
      'Send me your question and I will reply with text.',
      '',
      '💡 Gemini 3.1 Pro Preview via Google Gemini',
      '🔁 Automatic fallback to other Gemini chat models is enabled',
      '💰 Cost: {cost}⚡ per request',
      '💡 Tip: I remember the conversation context.'
    ].join('\n'),
    voiceActivated: [
      '🎙️ Voice chat mode activated! 🆓',
      '',
      'Send a voice message and I will transcribe it and reply.',
      '',
      '💡 Groq Whisper for free transcription',
      '💰 Gemini reply: {cost}⚡'
    ].join('\n'),
    visionActivated: [
      '🖼️ Gemini Vision mode activated! 💎',
      '',
      'Send me an image with or without a caption and I will analyze it.',
      '',
      '💰 Cost: {cost}⚡ per analysis'
    ].join('\n'),
    thinking: '🤔 Thinking...',
    analyzingImage: '👀 Analyzing image...',
    activateVoiceFirst: 'Activate voice mode first through "🧠 Assistants" → "🎙️ Voice".',
    imageModeHint: 'For image analysis, choose "🧠 Assistants" → "🖼️ Upload an image for analysis".'
  },
  legalInfo: {
    title: '📋 <b>Legal information</b>',
    prompt: [
      'Please review the legal documents before making a payment:',
      '',
      '📋 <b>Terms of service</b> — governs the relationship between the merchant and the cardholder',
      '🔒 <b>Privacy policy</b> — explains how we process your personal information',
      '',
      'Use the buttons below to open the full documents:'
    ].join('\n')
  },
  profile: {
    buyTokens: '💰 Buy tokens',
    providerChoice: '⚙️ Provider selection',
    community: '👥 Community',
    legalInfo: '📋 Legal information'
  },
  mainMenu: {
    title: '🏠 Main menu',
    greeting: 'Hello, {firstName}!',
    intro: 'I am neuro.lab.ai, your AI generation assistant.',
    balance: '💰 Your balance: {balance}⚡ FREE',
    cta: 'Choose a section below.'
  },
  welcome: {
    text: [
      'Top AI models in one place.',
      'Create text, images, video, and audio from Telegram.',
      'Self-hosted and ready to extend.'
    ].join('\n'),
    start: '✨ Start ✨'
  }
};
