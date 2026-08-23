const PendingMessage = require('../models/PendingMessage');
const crypto = require('crypto');
const { URL } = require('url');

class WebhookDelivery {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.pendingMessages = new PendingMessage(db);
    this.webhookUrl = config.WEBHOOK_URL?.replace(/\/+$/, '');
    this.webhookToken = config.WEBHOOK_TOKEN;
    this.maxAttempts = 5;
    this.isProcessing = false;
    this.processingInterval = null;
    this.batchSize = 10;
  }

  async init() {
    await this.pendingMessages.createIndexes();
    this.startProcessing();
  }

  // Main function to queue a message for delivery
  async queueMessage(messageData) {
    const existing = await this.pendingMessages.findByMessageId(messageData.messageId);
    if (existing) {
      return { alreadyExists: true, message: existing };
    }

    const message = await this.pendingMessages.save(messageData);
    return { created: true, message };
  }

  // Main processing loop
  startProcessing() {
    if (this.processingInterval) return;
    
    this.processingInterval = setInterval(async () => {
      if (this.isProcessing) return;
      
      this.isProcessing = true;
      try {
        await this.processPendingMessages();
      } catch (error) {
        console.error('Error processing pending messages:', error);
      } finally {
        this.isProcessing = false;
      }
    }, 5000); // Process every 5 seconds

    this.processingInterval.unref?.();
  }

  async processPendingMessages() {
    const messages = await this.pendingMessages.findPending(this.batchSize);
    if (messages.length === 0) return;

    for (const message of messages) {
      await this.attemptDelivery(message);
    }
  }

  async attemptDelivery(message) {
    const attemptNumber = message.attempts + 1;
    const startTime = Date.now();

    try {
      const payload = this.buildPayload(message);
      const response = await this.postToWebhook(payload);
      
      if (response.status >= 200 && response.status < 300) {
        await this.handleSuccess(message, response);
        return { success: true };
      } else {
        return await this.handleFailure(message, attemptNumber, 
          `HTTP ${response.status}: ${response.statusText}`, response.status);
      }
    } catch (error) {
      return await this.handleFailure(message, attemptNumber, error.message);
    }
  }

  async postToWebhook(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.webhookToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  }

  buildPayload(message) {
    const basePayload = {
      messages: [{
        id: message.messageId,
        from: message.from,
        ...(message.fromLid && { from_lid: message.fromLid }),
        name: message.name,
        timestamp: message.timestamp,
        type: message.type,
        text: message.text,
        context_id: message.contextId,
      }]
    };

    // Add optional fields based on message type
    if (message.media) {
      basePayload.messages[0].media = message.media;
    }
    if (message.location) {
      basePayload.messages[0].location = message.location;
    }
    if (message.contact) {
      basePayload.messages[0].contact = message.contact;
    }
    if (message.reaction) {
      basePayload.messages[0].reaction = message.reaction;
    }
    if (message.contextId) {
      basePayload.messages[0].context_id = message.contextId;
    }

    return basePayload;
  }

  async handleSuccess(message, response) {
    await this.pendingMessages.markAsSent(message.messageId, response.status, { status: response.status });

    // Log success
    this.logDelivery(message, true, null, response.status);
  }

  async handleFailure(message, attemptNumber, errorMessage, httpStatus = null) {
    const nextAttempt = message.attempts + 1;
    const maxAttempts = this.maxAttempts;
    
    if (nextAttempt >= this.maxAttempts) {
      // Mark as permanently failed
      await this.pendingMessages.markAsFailed(message.messageId, {
        message: `Max attempts reached: ${errorMessage}`,
      });
      
      this.logDelivery(null, false, `Max attempts reached: ${errorMessage}`, null);
      return { success: false, permanentlyFailed: true };
    } else {
      // Schedule retry with exponential backoff
      await this.pendingMessages.incrementAttemptWithBackoff(
        message.messageId,
        message.attempts || 0,
        { message: errorMessage, httpStatus },
      );
      
      this.logDelivery(message, false, errorMessage, null);
      return { success: false, willRetry: true };
    }
  }

  calculateNextRetry(attempt) {
    // Exponential backoff: 1min, 2min, 4min, 8min, 16min (max 15 min)
    const baseDelay = 60000; // 1 minute
    const delay = Math.min(60000 * Math.pow(2, attempt - 1), 900000); // max 15 min
    return new Date(Date.now() + delay);
  }

  logDelivery(message, success, error, httpStatus) {
    const logData = {
      messageId: message?.messageId,
      type: message?.type,
      from: message?.from ? this.anonymizePhone(message.from) : 'unknown',
      lid: message?.fromLid ? this.anonymizeLid(message.fromLid) : 'none',
      attempt: message?.attempts + 1,
      success,
      error: error || null,
      httpStatus,
    };
    
    // Mask sensitive data
    console.log(`[WEBHOOK] ${JSON.stringify(logData)}`);
  }

  anonymizePhone(phone) {
    if (!phone) return 'unknown';
    const str = String(phone);
    if (str.length <= 4) return '****';
    return str.slice(0, 2) + '*'.repeat(str.length - 4) + str.slice(-2);
  }

  anonymizeLid(lid) {
    if (!lid) return 'none';
    const str = String(lid);
    if (str.length <= 4) return '****';
    return str.slice(0, 2) + '*'.repeat(str.length - 4) + str.slice(-2);
  }

  // Get stats for monitoring
  async getStats() {
    return this.pendingMessages.getStats();
  }

  // Manual retry for failed messages
  async retryFailed(messageId) {
    return await this.pendingMessages.retryFailed(messageId);
  }

  stop() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }
}

module.exports = WebhookDelivery;
