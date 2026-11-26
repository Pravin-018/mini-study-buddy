import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  content: { type: String, required: true, trim: true, maxlength: 8000 },
  embedding: { type: [Number], default: null }
}, { timestamps: true });

export default mongoose.models.Note || mongoose.model('Note', noteSchema);
