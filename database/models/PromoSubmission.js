const mongoose = require('mongoose');

const promoSubmissionSchema = new mongoose.Schema({
  taskKey: { type: String, required: true, default: 'instagram_promo', index: true },
  userId: { type: Number, required: true, index: true },
  username: { type: String, default: '', index: true },
  fullName: { type: String, default: '' },
  languageCode: { type: String, default: 'en' },
  screenshotFileId: { type: String, required: true },
  screenshotType: { type: String, required: true, enum: ['photo', 'document'], default: 'photo' },
  instagramLink: { type: String, required: true },
  status: { type: String, required: true, enum: ['pending', 'approved', 'declined'], default: 'pending', index: true },
  rewardAmount: { type: Number, required: true, default: 30 },
  moderatedBy: { type: Number, default: null, index: true },
  moderatedAt: { type: Date, default: null },
  rewardGrantedAt: { type: Date, default: null },
  rewardLockAt: { type: Date, default: null },
  adminMessages: [{
    chatId: { type: Number, required: true },
    messageId: { type: Number, required: true }
  }]
}, {
  timestamps: true,
  collection: 'promo_submissions'
});

promoSubmissionSchema.index({ userId: 1, taskKey: 1, createdAt: -1 });
promoSubmissionSchema.index({ userId: 1, taskKey: 1, status: 1 });
promoSubmissionSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.PromoSubmission
  || mongoose.model('PromoSubmission', promoSubmissionSchema);
