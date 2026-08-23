// Configuration module
require('dotenv').config();

module.exports = {
  // Bot settings
  PREFIX: process.env.PREFIX || '!',
  BOT_NAME: process.env.BOT_NAME || 'MiBotWhatsApp',
  PORT: parseInt(process.env.PORT) || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Authentication
  API_TOKEN: process.env.API_TOKEN,
  
  // Webhook settings
  WEBHOOK_URL: (process.env.WEBHOOK_URL || '').replace(/\/+$/, ''),
  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN || '',
  PHONE_E164: process.env.PHONE_E164 || process.env.BOT_PHONE || '',
  AUTO_REGISTER_URL: (process.env.AUTO_REGISTER_URL || '').replace(/\/+$/, ''),

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DB: process.env.MONGODB_DB || 'whatsapp-bot',

  // Media settings
  MEDIA_STORAGE_PATH: process.env.MEDIA_STORAGE_PATH || 'media_storage',
  MEDIA_EXPIRY_MS: parseInt(process.env.MEDIA_EXPIRY_MS) || 3600000, // 1 hour
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024, // 100MB

  // Tunneling
  TUNNEL_ENABLED: process.env.TUNNEL_ENABLED !== 'false',
  TUNNEL_HOST: process.env.TUNNEL_HOST || '127.0.0.1',

  // Rate limiting
  MAX_FORWARDED_IDS: 4000,
  MAX_CACHE_SIZE: 10000,

  // Retry settings
  MAX_DELIVERY_ATTEMPTS: 5,
  BASE_RETRY_DELAY_MS: 60000, // 1 minute
  MAX_RETRY_DELAY_MS: 900000, // 15 minutes
};
