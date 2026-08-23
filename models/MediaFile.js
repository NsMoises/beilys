const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const path = require('path');

class MediaFile {
  constructor(db) {
    this.db = db;
    this.useMongo = !!db;
    this.memoryStore = new Map(); // In-memory fallback
    this.storagePath = process.env.MEDIA_STORAGE_PATH || path.join(__dirname, '../../media_storage');
  }

  get collection() {
    return this.db?.collection('media_files');
  }

  async createIndexes() {
    if (this.useMongo && this.collection) {
      await this.collection.createIndex({ downloadId: 1 }, { unique: true });
      await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await this.collection.createIndex({ originalMessageId: 1 });
    }
  }

  generateDownloadId() {
    return crypto.randomBytes(16).toString('hex');
  }

  async save(fileData) {
    const downloadId = this.generateDownloadId();
    const expiresAt = new Date(Date.now() + (process.env.MEDIA_EXPIRY_MS || 3600000)); // 1 hour default

    const doc = {
      downloadId,
      originalMessageId: fileData.originalMessageId,
      originalJid: fileData.originalJid,
      mimeType: fileData.mimeType,
      filename: fileData.filename,
      size: fileData.size,
      duration: fileData.duration,
      voiceNote: fileData.voiceNote || false,
      filePath: fileData.filePath,
      mimeType: fileData.mimeType,
      createdAt: new Date(),
      expiresAt,
      downloaded: false,
      downloadCount: 0,
    };

    if (this.useMongo && this.collection) {
      await this.collection.insertOne(doc);
    } else {
      this.memoryStore.set(downloadId, doc);
    }
    return { downloadId, ...doc };
  }

  async findByDownloadId(downloadId) {
    if (this.useMongo && this.collection) {
      return await this.collection.findOne({ downloadId });
    }
    return this.memoryStore.get(downloadId) || null;
  }

  async markAsDownloaded(downloadId) {
    if (this.useMongo && this.collection) {
      return await this.collection.updateOne(
        { downloadId },
        {
          $set: { downloaded: true, downloadedAt: new Date() },
          $inc: { downloadCount: 1 }
        }
      );
    }
    const doc = this.memoryStore.get(downloadId);
    if (doc) {
      doc.downloaded = true;
      doc.downloadedAt = new Date();
      doc.downloadCount = (doc.downloadCount || 0) + 1;
    }
  }

  async deleteExpired() {
    if (this.useMongo && this.collection) {
      const result = await this.collection.deleteMany({
        expiresAt: { $lt: new Date() }
      });
      return result.deletedCount;
    }
    let deleted = 0;
    const now = Date.now();
    for (const [id, doc] of this.memoryStore.entries()) {
      if (doc.expiresAt && new Date(doc.expiresAt).getTime() < now) {
        this.memoryStore.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  async getStats() {
    if (this.useMongo && this.collection) {
      return await this.collection.aggregate([
        { $group: { _id: '$downloaded', count: { $sum: 1 } } }
      ]).toArray();
    }
    return Array.from(this.memoryStore.values());
  }
}

module.exports = MediaFile;