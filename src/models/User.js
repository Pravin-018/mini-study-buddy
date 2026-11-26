import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: 254,
    match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  },
  password: {
    type: String,
    required: function requirePasswordForLocalAccount() { return !this.googleId; },
    select: false,
    validate: {
      validator: value => value == null || /^\$2[aby]\$\d\d\$/.test(value),
      message: 'Password must be stored as a bcrypt hash.'
    }
  },
  role: { type: String, enum: ['student', 'admin'], default: 'student', required: true },
  googleId: { type: String, unique: true, sparse: true }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

export default mongoose.models.User || mongoose.model('User', userSchema);
