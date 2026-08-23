const crypto = require('crypto');

class PendingMessage {
  constructor(db) {
    this.db = db;
    this.useMongo = !!db;
    this.memoryStore = new Map();
  }

  async createIndexes() {
    if (this.useMongo) {
      await this.collection.createIndex({ status: 1, nextRetryAt: 1 });
      await this.collection.createIndex({ messageId: 1 });
      await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800 });
    }
  }

  get collection() {
    return this.db?.collection('pending_messages');
  }

  get memoryCollection() {
    return this.memoryStore;
  }

  async save(messageData) {
    const doc = {
      messageId: messageData.messageId,
      from: messageData.from,
      fromLid: messageData.fromLid,
      name: messageData.name,
      timestamp: messageData.timestamp,
      type: messageData.type,
      text: messageData.text,
      contextId: messageData.contextId,
      media: messageData.media,
      location: messageData.location,
      contact: messageData.contact,
      reaction: messageData.reaction,
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: new Date(),
      lastError: null,
      responseStatus: null,
      lastResponse: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (this.useMongo && this.collection) {
      const result = await this.collection.insertOne(doc);
      const saved = { ...doc, _id: result.insertedId };
      this.memoryStore.set(messageData.messageId, saved);
      return saved;
    } else {
      const docWithId = { ...doc, _id: crypto.randomUUID() };
      this.memoryStore.set(messageData.messageId, docWithId);
      return docWithId;
    }
  }

  async findPending(limit = 100) {
    const memoryPending = Array.from(this.memoryStore.values())
      .filter(m => m.status === 'pending' && m.nextRetryAt <= new Date())
      .sort((a, b) => a.nextRetryAt - b.nextRetryAt)
      .slice(0, limit);

    if (this.useMongo && this.collection) {
      const cursor = this.collection.find({ status: 'pending', nextRetryAt: { $lte: new Date() } });
      if (cursor?.sort && cursor?.limit && cursor?.toArray) {
        return await cursor.sort({ nextRetryAt: 1 }).limit(limit).toArray();
      }
      if (cursor?.limit && cursor?.toArray) {
        return await cursor.limit(limit).toArray();
      }
    }

    return memoryPending;
  }

  async findByMessageId(messageId) {
    const cached = this.memoryStore.get(messageId);
    if (cached) return cached;

    if (this.useMongo && this.collection) {
      return await this.collection.findOne({ messageId });
    } else {
      return this.memoryStore.get(messageId) || null;
    }
  }

  async incrementAttempt(messageId, error) {
    if (this.useMongo && this.collection) {
      return await this.collection.updateOne(
        { messageId },
        {
          $inc: { attempts: 1 },
          $set: {
            lastError: error?.message || 'Unknown error',
            nextRetryAt: this.calculateNextRetry(1),
            updatedAt: new Date(),
          },
          $push: {
            attemptHistory: {
              attempt: 1,
              error: error?.message,
              timestamp: new Date(),
            }
          }
        });
    }

    const msg = this.memoryStore.get(messageId);
    if (msg) {
      msg.attempts = (msg.attempts || 0) + 1;
      msg.lastError = error?.message || 'Unknown error';
      msg.nextRetryAt = this.calculateNextRetry(msg.attempts);
      msg.updatedAt = new Date();
      msg.attemptHistory = (msg.attemptHistory || []).concat([{
        attempt: msg.attempts,
        error: error?.message,
        timestamp: new Date(),
      }]);
    }
  }

  async incrementAttemptWithBackoff(messageId, currentAttempts, error) {
    const nextAttempt = currentAttempts + 1;
    const maxAttempts = 5;
    const nextRetryAt = this.calculateNextRetry(nextAttempt);
    
    const update = {
      $inc: { attempts: 1 },
      $set: {
        status: nextAttempt >= 5 ? 'failed' : 'pending',
        lastError: error?.message || 'Unknown error',
        nextRetryAt: nextAttempt >= 5 ? null : this.calculateNextRetry(currentAttempts + 1),
        updatedAt: new Date(),
      },
      $push: {
        attemptHistory: {
          attempt: currentAttempts + 1,
          error: error?.message,
          timestamp: new Date(),
        }
      }
    };
    
    if (nextAttempt >= 5) {
      delete update.$set.nextRetryAt;
    }
    
    if (this.useMongo && this.collection) {
      await this.collection.updateOne({ messageId }, update);
    }

    const msg = this.memoryStore.get(messageId);
    if (msg) {
      msg.attempts = nextAttempt;
      msg.status = nextAttempt >= 5 ? 'failed' : 'pending';
      msg.lastError = error?.message || 'Unknown error';
      msg.nextRetryAt = nextAttempt >= 5 ? null : this.calculateNextRetry(currentAttempts + 1);
      msg.updatedAt = new Date();
      msg.attemptHistory = (msg.attemptHistory || []).concat([{
        attempt: currentAttempts + 1,
        error: error?.message,
        timestamp: new Date(),
      }]);
    }
  }

  calculateNextRetry(attempt) {
    const baseDelay = 60000;
    const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 900000);
    return new Date(Date.now() + delay);
  }

  async markAsSent(messageId, responseStatus, responseBody) {
    if (this.useMongo && this.collection) {
      await this.collection.updateOne(
        { messageId },
        {
          $set: {
            status: 'sent',
            responseStatus,
            lastResponse: JSON.stringify({ status: responseStatus, body: responseBody }),
            sentAt: new Date(),
            updatedAt: new Date(),
          }
        }
      );
    }

    const msg = this.memoryStore.get(messageId);
    if (msg) {
      msg.status = 'sent';
      msg.responseStatus = responseStatus;
      msg.lastResponse = JSON.stringify({ status: responseStatus, body: responseBody });
      msg.sentAt = new Date();
      msg.updatedAt = new Date();
    }
  }

  async markAsFailed(messageId, error) {
    if (this.useMongo && this.collection) {
      await this.collection.updateOne(
        { messageId },
        {
          $set: {
            status: 'failed',
            lastError: error?.message || 'Unknown error',
            updatedAt: new Date(),
          }
        }
      );
    }

    const msg = this.memoryStore.get(messageId);
    if (msg) {
      msg.status = 'failed';
      msg.lastError = error?.message || 'Unknown error';
      msg.updatedAt = new Date();
    }
  }

  async retryFailed(messageId) {
    if (this.useMongo && this.collection) {
      await this.collection.updateOne(
        { messageId },
        {
          $set: {
            status: 'pending',
            attempts: 0,
            lastError: null,
            nextRetryAt: new Date(),
            updatedAt: new Date(),
          }
        }
      );
    }

    const msg = this.memoryStore.get(messageId);
    if (msg) {
      msg.status = 'pending';
      msg.attempts = 0;
      msg.lastError = null;
      msg.nextRetryAt = new Date();
      msg.updatedAt = new Date();
    }
  }

  async getStats() {
    if (this.useMongo && this.collection) {
      const stats = await this.collection.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]).toArray();
      
      return stats.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, { pending: 0, sent: 0, failed: 0 });
    } else {
      const stats = { pending: 0, sent: 0, failed: 0 };
      for (const msg of this.memoryStore.values()) {
        if (msg.status) stats[msg.status] = (stats[msg.status] || 0) + 1;
      }
      return stats;
    }
  }

  async cleanupOld() {
    if (this.useMongo && this.collection) {
      const result = await this.collection.deleteMany({
        $or: [
          { status: 'sent', sentAt: { $lt: new Date(Date.now() - 86400000) } },
          { status: 'failed', updatedAt: { $lt: new Date(Date.now() - 604800000) } }
        ]
      });
      return result.deletedCount;
    } else {
      let deleted = 0;
      const now = Date.now();
      for (const [id, msg] of this.memoryStore.entries()) {
        if ((msg.status === 'sent' && msg.sentAt && msg.sentAt.getTime() < now - 86400000) ||
            (msg.status === 'failed' && msg.updatedAt && msg.updatedAt.getTime() < now - 604800000)) {
          this.memoryStore.delete(id);
          deleted++;
        }
      }
      return deleted;
    }
  }
}

module.exports = PendingMessage;
