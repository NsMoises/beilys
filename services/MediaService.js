const MediaFile = require('../models/MediaFile');
const { proto, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

class MediaService {
  constructor(db, socket, config) {
    this.db = db;
    this.socket = socket;
    this.config = config;
    this.mediaFile = new MediaFile(db);
    this.storagePath = config.MEDIA_STORAGE_PATH || path.join(process.cwd(), 'media_storage');
    this.maxFileSize = config.MAX_FILE_SIZE || 100 * 1024 * 1024; // 100MB default
    this.mediaExpiryMs = config.MEDIA_EXPIRY_MS || 3600000; // 1 hour
  }

  async init() {
    await this.mediaFile.createIndexes();
    await fs.mkdir(this.storagePath, { recursive: true });
  }

  // Main function to process media from a message
  async processMediaMessage(msg) {
    const messageType = this.getMessageType(msg);
    if (!messageType) return null;

    try {
      const mediaData = await this.extractMediaData(msg, messageType);
      if (!mediaData) return null;

      // Download the media
      const buffer = await this.downloadMedia(msg, messageType);
      if (!buffer) {
        // Send metadata with media_unavailable status instead of losing the message
        return {
          type: messageType,
          media: {
            status: 'media_unavailable',
            mimeType: mediaData.mimeType,
            filename: mediaData.filename,
            size: mediaData.size,
            duration: mediaData.duration,
            voiceNote: messageType === 'audio' && mediaData.isVoiceNote,
          },
        };
      }

      // Save to disk
      const filePath = await this.saveMediaFile(messageType, buffer, msg.key.id);
      
      // Save metadata to database
      const mediaFile = await this.saveMediaFileMetadata({
        originalMessageId: msg.key.id,
        originalJid: msg.key.remoteJid,
        mimeType: mediaData.mimeType,
        filename: mediaData.filename,
        size: buffer.length,
        duration: mediaData.duration,
        voiceNote: messageType === 'audio' && mediaData.isVoiceNote,
        filePath: filePath,
      });

      return {
        type: messageType,
        media: {
          downloadId: mediaData.downloadId,
          mimeType: mediaData.mimeType,
          filename: mediaData.filename,
          size: buffer.length,
          duration: mediaData.duration,
          voiceNote: messageType === 'audio' && mediaData.isVoiceNote,
        },
        mediaId: mediaFile.downloadId,
      };
    } catch (error) {
      console.error('Error processing media message:', error);
      return {
        type: messageType,
        media: { unavailable: true, reason: error.message },
      };
    }
  }

  getMessageType(msg) {
    const message = msg.message;
    if (!message) return null;
    
    if (message.imageMessage) return 'image';
    if (message.audioMessage) return 'audio';
    if (message.videoMessage) return 'video';
    if (message.documentMessage) return 'document';
    if (message.stickerMessage) return 'sticker';
    if (message.locationMessage) return 'location';
    if (message.contactMessage) return 'contact';
    if (message.reactionMessage) return 'reaction';
    if (message.extendedTextMessage?.contextInfo?.stanzaId) return 'reply';
    if (message.conversation || message.extendedTextMessage?.text) return 'text';
    
    return null;
  }

  async extractMediaData(msg, messageType) {
    const message = msg.message;
    const mediaMessage = message[`${messageType}Message`];
    
    if (!mediaMessage) return null;

    const mimeType = mediaMessage.mimetype || this.guessMimeType(messageType, mediaMessage);
    const filename = mediaMessage.fileName || this.generateFilename(messageType, mediaMessage);
    const size = mediaMessage.fileLength || mediaMessage.fileSize || 0;
    const duration = mediaMessage.seconds || mediaMessage.duration || 0;
    const isVoiceNote = messageType === 'audio' && mediaMessage.ptt === true;

    return {
      mimeType,
      filename,
      size,
      duration,
      isVoiceNote,
      mediaKey: mediaMessage.mediaKey,
      directPath: mediaMessage.directPath,
      url: mediaMessage.url,
    };
  }

  async downloadMedia(msg, messageType) {
    try {
      const message = msg.message;
      const mediaMessage = message[`${messageType}Message`];
      
      if (!mediaMessage) return null;

      // Use Baileys' official download utility
      const stream = await downloadContentFromMessage(mediaMessage, messageType);
      const chunks = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      console.error('Error downloading media:', error);
      return null;
    }
  }

  async saveMediaFile(messageType, buffer, messageId) {
    const ext = this.getExtensionFromMimeType(messageType);
    const filename = `${messageId}${ext}`;
    const filePath = path.join(this.storagePath, filename);
    
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async saveMediaFileMetadata(fileData) {
    return this.mediaFile.save(fileData);
  }

  getExtensionFromMimeType(messageType) {
    const extensions = {
      image: '.jpg',
      audio: '.ogg',
      video: '.mp4',
      document: '.pdf',
      sticker: '.webp',
    };
    return extensions[messageType] || '.bin';
  }

  guessMimeType(messageType, mediaMessage) {
    const defaults = {
      image: 'image/jpeg',
      audio: 'audio/ogg',
      video: 'video/mp4',
      document: 'application/pdf',
      sticker: 'image/webp',
    };
    return mediaMessage.mimetype || defaults[messageType] || 'application/octet-stream';
  }

  generateFilename(messageType, mediaMessage) {
    const ext = this.getExtensionFromMimeType(messageType);
    return `media_${Date.now()}${ext}`;
  }

  // Clean up old files periodically
  async cleanupOldFiles() {
    const deletedCount = await this.mediaFile.deleteExpired();
    console.log(`Cleaned up ${deletedCount} expired media files`);
    return deletedCount;
  }

  // Get media for download endpoint
  async getMediaForDownload(downloadId) {
    return await this.mediaFile.findByDownloadId(downloadId);
  }

  // Mark as downloaded
  async markAsDownloaded(downloadId) {
    return await this.mediaFile.markAsDownloaded(downloadId);
  }
}

module.exports = MediaService;
