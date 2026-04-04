const mongoose = require('mongoose');

const generationResultSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  username: { type: String, index: true },
  modelKey: { type: String, required: true, index: true },
  modelName: { type: String, required: true },
  resultUrl: { type: String, required: true },
  resultType: { type: String, enum: ['video', 'image', 'audio'], required: true },
  prompt: { type: String },
  options: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  duration: { type: Number },
  fileSize: { type: Number },
  success: { type: Boolean, required: true, default: true },
  errorMessage: { type: String },
  provider: { type: String, enum: ['replicate', 'kie-ai', 'a2e', 'other'], index: true },
  providerTaskId: { type: String },
  tokensSpent: { type: Number },
  apiCostUSD: { type: Number },
  createdAt: { type: Date, default: Date.now, index: true },
  generatedAt: { type: Date }
}, {
  timestamps: true,
  collection: 'generation_results'
});

generationResultSchema.index({ userId: 1, createdAt: -1 });
generationResultSchema.index({ modelKey: 1, createdAt: -1 });
generationResultSchema.index({ provider: 1, createdAt: -1 });
generationResultSchema.index({ success: 1, createdAt: -1 });

module.exports = mongoose.models.GenerationResult
  || mongoose.model('GenerationResult', generationResultSchema);
