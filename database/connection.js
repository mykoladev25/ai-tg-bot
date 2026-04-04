const mongoose = require('mongoose');
require('dotenv').config();

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/telegram-ai-bot';
const MONGODB_URI = process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
const CONNECTION_TIMEOUT_MS = 10000;

async function connect() {
  try {
    const connectPromise = mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
      socketTimeoutMS: CONNECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECTION_TIMEOUT_MS
    });

    await Promise.race([
      connectPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`MongoDB connection timeout after ${CONNECTION_TIMEOUT_MS / 1000}s`)), CONNECTION_TIMEOUT_MS);
      })
    ]);

    console.log('Connected to MongoDB');

    mongoose.connection.on('error', (error) => {
      console.error('MongoDB connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected');
    });

    return true;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    console.log('The bot will continue without database persistence');
    return false;
  }
}

async function disconnect() {
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
  }
}

async function healthCheck() {
  try {
    const state = mongoose.connection.readyState;
    return {
      status: state === 1 ? 'healthy' : 'unhealthy',
      state: ['disconnected', 'connected', 'connecting', 'disconnecting'][state],
      database: mongoose.connection.name
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message
    };
  }
}

module.exports = {
  connect,
  disconnect,
  healthCheck,
  mongoose
};
