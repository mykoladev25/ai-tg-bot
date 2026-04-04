const mongoose = require('mongoose');

const pendingGenerationTaskSchema = new mongoose.Schema({
  taskId: { type: String, required: true, unique: true, index: true },
  provider: { type: String, required: true, default: 'kie-ai', index: true },
  resultType: { type: String, required: true, default: 'video', enum: ['video', 'image', 'audio'], index: true },
  pollStrategy: { type: String, required: true, default: 'recordInfo', enum: ['recordInfo', 'runway', 'veo'], index: true },
  status: { type: String, required: true, default: 'pending', enum: ['pending', 'delivering', 'delivered', 'failed'], index: true },
  chatId: { type: Number, required: true, index: true },
  userId: { type: Number, required: true, index: true },
  username: { type: String, index: true },
  modelKey: { type: String, required: true, index: true },
  modelName: { type: String, required: true },
  cost: { type: Number, required: true },
  deductDescription: { type: String, required: true },
  deductMeta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  promptSnippet: { type: String, default: '' },
  captionLine: { type: String, default: '' },
  monitorOptions: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  lastState: { type: String, default: '' },
  failureMessage: { type: String, default: '' },
  resultUrl: { type: String, default: '' },
  deliveredAt: { type: Date, default: null },
  lastCheckedAt: { type: Date, default: null }
}, {
  timestamps: true,
  collection: 'pending_generation_tasks'
});

pendingGenerationTaskSchema.index({ provider: 1, status: 1, createdAt: -1 });
pendingGenerationTaskSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.PendingGenerationTask
  || mongoose.model('PendingGenerationTask', pendingGenerationTaskSchema);
