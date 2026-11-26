import mongoose from 'mongoose';

export async function connectDatabase(uri = process.env.MONGODB_URI) {
  if (!uri) throw new Error('MONGODB_URI must be set before the application can start.');

  mongoose.connection.on('error', error => {
    console.error('MongoDB connection error:', error);
  });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  console.log('Connected to MongoDB.');
  return mongoose.connection;
}
