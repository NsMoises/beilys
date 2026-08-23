const LidResolver = require('./LidResolver');
const WebhookDelivery = require('./WebhookDelivery');
const MediaService = require('./MediaService');
const crypto = require('crypto');

class MessageProcessor {
  constructor(db, socket, config) {
    this.db = db;
    this.socket = socket;
    this.config = config;
    this.lidResolver = new LidResolver(db, socket);
    this.webhookDelivery = new WebhookDelivery(db, config);
    this.mediaService = new MediaService(db, socket, config);
    this.forwardedIds = new Set();
    this.MAX_FORWARDED_IDS = 4000;
    this.messageCache = new Map(); // For deduplication
    this.MAX_CACHE_SIZE = 10000;
  }

  async init() {
    await this.lidResolver.init();
    await this.webhookDelivery.init();
    await this.mediaService.init();
    console.log('MessageProcessor initialized');
  }

  // Main entry point for processing messages
  async processMessage(msg) {
    // Skip own messages
    if (msg.key.fromMe) return;
    
    // Skip status broadcasts
    if (msg.key.remoteJid === 'status@broadcast') return;

    const remoteJid = msg.key.remoteJid;
    const isLid = remoteJid?.endsWith('@lid');
    const isRegular = remoteJid?.endsWith('@s.whatsapp.net');

    if (!isLid && !isRegular) return;

    // Skip events with requestId (sent messages)
    if (msg.key.requestId) return;

    // Deduplication
    if (this.isProcessed(msg.key.id)) return;
    this.markAsProcessed(msg.key.id);

    // Resolve sender phone number
    let fromPhoneJid = null;

    if (isRegular) {
      fromPhoneJid = remoteJid;
    } else if (isLid) {
      fromPhoneJid = await this.lidResolver.resolvePhoneFromLid(msg);
      if (!fromPhoneJid) {
        console.warn(`Could not resolve LID ${remoteJid} for message ${msg.key.id}`);
        return;
      }
    }

    const fromPhone = this.normalizePhoneFromJid(fromPhoneJid);
    const messageType = this.getMessageType(msg);
    const messageContent = this.extractMessageContent(msg);

    // Location: no download needed
    if (messageType === 'location') {
      await this.queueForWebhook({
        ...this.buildBaseMessage(msg, fromPhone, 'location', messageContent),
        location: this.extractLocation(msg),
      });
      return;
    }

    // Contact: no download needed
    if (messageType === 'contact') {
      await this.queueForWebhook({
        ...this.buildBaseMessage(msg, fromPhone, 'contact', messageContent),
        contact: this.extractContact(msg),
      });
      return;
    }

    // Reaction: no download needed
    if (messageType === 'reaction') {
      await this.queueForWebhook({
        ...this.buildBaseMessage(msg, fromPhone, 'reaction'),
        reaction: this.extractReaction(msg),
      });
      return;
    }

    // Media types: download and attach metadata (caption goes in text)
    const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
    if (MEDIA_TYPES.includes(messageType)) {
      const mediaResult = await this.mediaService.processMediaMessage(msg);
      if (mediaResult) {
        await this.queueForWebhook({
          ...this.buildBaseMessage(msg, fromPhone, mediaResult.type, messageContent),
          media: mediaResult.media,
        });
        return;
      }
      return;
    }

    // Text / reply
    if (!messageContent) return;
    await this.queueForWebhook(
      this.buildBaseMessage(msg, fromPhone, messageType, messageContent),
    );
  }

  extractLocation(msg) {
    const loc = msg.message?.locationMessage;
    if (!loc) return undefined;
    return {
      latitude: loc.degreesLatitude ?? null,
      longitude: loc.degreesLongitude ?? null,
      name: loc.name || undefined,
      address: loc.address || undefined,
    };
  }

  extractContact(msg) {
    const contact = msg.message?.contactMessage;
    if (!contact) return undefined;
    return {
      display_name: contact.displayName || undefined,
      vcard: contact.vcard || undefined,
    };
  }

  extractReaction(msg) {
    const reaction = msg.message?.reactionMessage;
    if (!reaction) return undefined;
    return {
      emoji: reaction.text || undefined,
      message_id: reaction.key?.id || undefined,
    };
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

  extractMessageContent(msg) {
    const message = msg.message;
    if (!message) return null;

    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    
    return null;
  }

  buildBaseMessage(msg, fromPhone, type, content = null) {
    return {
      messageId: msg.key.id,
      from: fromPhone,
      fromLid: msg.key.remoteJid?.endsWith('@lid') ? msg.key.remoteJid : undefined,
      name: msg.pushName,
      timestamp: msg.messageTimestamp 
        ? Math.floor(Number(msg.messageTimestamp) || 0)
        : Math.floor(Date.now() / 1000),
      type: type,
      text: content,
      contextId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
    };
  }

  normalizePhoneFromJid(jid) {
    if (!jid) return null;

    const bare = String(jid)
      .replace('@s.whatsapp.net', '')
      .replace(/:\d+$/, '');

    return bare.replace(/[^\d]/g, '');
  }

  async queueForWebhook(messageData) {
    // Note: deduplication already happened in processMessage
    // Add to webhook delivery queue
    await this.webhookDelivery.queueMessage({
      ...messageData,
      type: messageData.type,
      text: messageData.text,
      contextId: messageData.contextId,
      media: messageData.media,
      location: messageData.location,
      contact: messageData.contact,
      reaction: messageData.reaction,
    });
  }

  isProcessed(messageId) {
    return this.messageCache.has(messageId);
  }

  markAsProcessed(messageId) {
    this.messageCache.set(messageId, Date.now());
    if (this.messageCache.size > 10000) {
      const firstKey = this.messageCache.keys().next().value;
      if (firstKey) this.messageCache.delete(firstKey);
    }
  }

  // Handle delivery status updates (accepts single update or array)
  async handleMessageUpdate(updates) {
    const list = Array.isArray(updates) ? updates : [updates];
    const statuses = [];

    for (const update of list) {
      const id = update.key?.id;
      if (!id) continue;

      // Map Baileys status codes
      // 2 = sent, 3 = delivered, 4 = read
      let status = null;
      if (update.status === 2) status = 'sent';
      else if (update.status === 3) status = 'delivered';
      else if (update.status === 4) status = 'read';
      else continue;

      const statusKey = `st:${id}:${status}`;
      if (this.forwardedIds.has(statusKey)) continue;

      this.forwardedIds.add(statusKey);
      if (this.forwardedIds.size > this.MAX_FORWARDED_IDS) {
        const firstKey = this.forwardedIds.keys().next().value;
        if (firstKey) this.forwardedIds.delete(firstKey);
      }

      statuses.push({
        id,
        status,
        timestamp: update.receiptTimestamp
          ? Math.floor(Number(update.receiptTimestamp) || 0)
          : Math.floor(Date.now() / 1000),
      });
    }

    if (statuses.length > 0) {
      await this.webhookDelivery.forwardToWebhook({ statuses });
    }
  }

  // Handle message deletion
  async handleMessageDelete(update) {
    const id = update.key?.id;
    if (!id) return;

    // Forward delete event to webhook
    const payload = {
      deleted: [{ id, timestamp: Math.floor(Date.now() / 1000) }]
    };

    await this.forwardToWebhook({ deleted: payload.deleted });
  }

  // Handle message edit
  async handleMessageEdit(update) {
    const id = update.key?.id;
    if (!id) return;

    const payload = {
      edited: [{
        id,
        text: update.message?.conversation || update.message?.extendedTextMessage?.text,
        timestamp: Math.floor(Date.now() / 1000),
      }]
    };

    await this.forwardToWebhook({ edited: payload.edited });
  }

  forwardToWebhook(payload) {
    return this.webhookDelivery.forwardToWebhook(payload);
  }

  // Get processing stats
  async getStats() {
    return {
      processedMessages: this.messageCache.size,
      forwardedIds: this.forwardedIds.size,
      webhookStats: await this.webhookDelivery.getStats(),
    };
  }
}

module.exports = MessageProcessor;
