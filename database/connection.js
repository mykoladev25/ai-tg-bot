const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/neurolab_bot';

async function connect() {
  try {
    // ⏱️ Set connection timeout to 10 seconds
    const connectPromise = mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    // Race: either connect or timeout after 10 seconds
    await Promise.race([
      connectPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('MongoDB connection timeout after 10s')), 10000)
      )
    ]);

    console.log('✅ Connected to MongoDB');
    
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ MongoDB disconnected');
    });
    
    return true;
  } catch (error) {
    console.error('⚠️ Failed to connect to MongoDB:', error.message);
    console.log('⚠️ Bot will continue without database (read-only mode)');
    return false;
  }
}

async function disconnect() {
  try {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error);
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