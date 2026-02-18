const mongoose = require('mongoose');

/**
 * GenerationResult - зберігає результати генерації (URL відео/зображень)
 * для подальшого аналізу та моніторингу
 */
const generationResultSchema = new mongoose.Schema({
  // Ідентифікація користувача
  userId: { type: Number, required: true, index: true },
  username: { type: String, index: true },
  
  // Інформація про модель
  modelKey: { type: String, required: true, index: true },
  modelName: { type: String, required: true },
  
  // Результат генерації
  resultUrl: { type: String, required: true },  // URL відео або зображення
  resultType: { type: String, enum: ['video', 'image', 'audio'], required: true },
  
  // Параметри генерації
  prompt: { type: String },
  options: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Метадані
  duration: { type: Number },  // Тривалість відео в секундах (якщо відео)
  fileSize: { type: Number },  // Розмір файлу в байтах (якщо відомий)
  
  // Статус
  success: { type: Boolean, required: true, default: true },
  errorMessage: { type: String },
  
  // Додаткова інформація від API провайдера
  provider: { type: String, enum: ['replicate', 'kie-ai', 'a2e', 'other'], index: true },
  providerTaskId: { type: String },  // ID задачі у провайдера (для відстеження)
  
  // Вартість
  tokensSpent: { type: Number },
  apiCostUSD: { type: Number },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now, index: true },
  generatedAt: { type: Date }  // Коли фактично завершилась генерація
}, {
  timestamps: true,
  collection: 'generation_results'
});

// Індекси для швидкого пошуку
generationResultSchema.index({ userId: 1, createdAt: -1 });
generationResultSchema.index({ modelKey: 1, createdAt: -1 });
generationResultSchema.index({ provider: 1, createdAt: -1 });
generationResultSchema.index({ success: 1, createdAt: -1 });

module.exports = mongoose.models.GenerationResult
  || mongoose.model('GenerationResult', generationResultSchema);
