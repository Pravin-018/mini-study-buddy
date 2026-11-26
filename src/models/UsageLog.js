import mongoose from 'mongoose';

const usageLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  model: { type: String, required: true },
  inputTokens: { type: Number, min: 0, default: 0, required: true },
  outputTokens: { type: Number, min: 0, default: 0, required: true },
  estimatedCostUsd: { type: Number, min: 0, default: 0, required: true }
}, { timestamps: { createdAt: true, updatedAt: false } });

usageLogSchema.index({ userId: 1, createdAt: -1 });
usageLogSchema.index({ createdAt: -1 });

export default mongoose.models.UsageLog || mongoose.model('UsageLog', usageLogSchema);
