const LidMapping = require('../models/LidMapping');

class LidResolver {
  constructor(db, socket) {
    this.db = db;
    this.socket = socket;
    this.lidMapping = db ? new LidMapping(db) : null;
    this.localCache = new Map(); // lid -> phoneJid
    this.maxCacheSize = 10000;
    this.useMongo = !!db;
  }

  async init() {
    if (this.useMongo && this.lidMapping) {
      await this.lidMapping.createIndexes();
      // Load recent mappings into memory cache
      const mappings = await this.db.collection('lid_mappings')
        .find({}, { projection: { lid: 1, phoneJid: 1 } })
        .limit(10000)
        .toArray();
      
      for (const mapping of mappings) {
        this.localCache.set(mapping.lid, mapping.phoneJid);
      }
      console.log(`Loaded ${this.localCache.size} LID mappings into memory`);
    } else {
      console.log('MongoDB not configured, using in-memory LID cache only');
    }
  }

async resolvePhoneFromLid(msg) {
    const remoteJid = msg.key.remoteJid;
    const lid = remoteJid.endsWith('@lid') ? remoteJid : null;
    
    if (!lid) return null;

    // 1. Try remoteJidAlt
    if (msg.key.remoteJidAlt && String(msg.key.remoteJidAlt).endsWith('@s.whatsapp.net')) {
      return msg.key.remoteJidAlt;
    }

    // 2. Try participantPn
    if (msg.key.participantPn && String(msg.key.participantPn).endsWith('@s.whatsapp.net')) {
      return msg.key.participantPn;
    }

    // 3. Try senderPn
    if (msg.key.senderPn && String(msg.key.senderPn).endsWith('@s.whatsapp.net')) {
      return msg.key.senderPn;
    }

    // 4. Try participantAlt
    if (msg.key.participantAlt && String(msg.key.participantAlt).endsWith('@s.whatsapp.net')) {
      return msg.key.participantAlt;
    }

    // 5. Try local cache
    const cachedPn = this.localCache.get(lid);
    if (cachedPn && String(cachedPn).endsWith('@s.whatsapp.net')) {
      return cachedPn;
    }

    // 6. Try MongoDB
    if (this.useMongo && this.lidMapping) {
      const mapping = await this.lidMapping.findByLid(lid);
      if (mapping && mapping.phoneJid && String(mapping.phoneJid).endsWith('@s.whatsapp.net')) {
        this.localCache.set(lid, mapping.phoneJid);
        return mapping.phoneJid;
      }
    }

    // 7. Try socket.signalRepository.lidMapping.getPNForLID(lid)
    if (this.socket?.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await this.socket.signalRepository.lidMapping.getPNForLID(lid);
        if (pn && String(pn).endsWith('@s.whatsapp.net')) {
          await this.saveMapping(lid, pn);
          return pn;
        }
      } catch (e) {
        // Ignore errors from signalRepository
      }
    }

    return null;
  }

  async saveMapping(lid, phoneJid) {
    if (!lid || !phoneJid) return;
    
    // Update local cache
    this.localCache.set(lid, phoneJid);
    
    // Prune cache if too large
    if (this.localCache.size > this.maxCacheSize) {
      const firstKey = this.localCache.keys().next().value;
      if (firstKey) this.localCache.delete(firstKey);
    }

    // Persist to MongoDB if available
    if (this.useMongo && this.lidMapping) {
      try {
        await this.lidMapping.save(lid, phoneJid);
      } catch (e) {
        console.error('Failed to save LID mapping:', e.message);
      }
    }
  }

  // Handle lid-mapping.update event
  handleLidMappingUpdate({ lid, pn }) {
    if (lid && pn) {
      this.localCache.set(lid, pn);
      if (this.useMongo && this.lidMapping) {
        this.lidMapping.save(lid, pn).catch(e => console.error('Failed to save LID mapping:', e.message));
      }
    }
  }

  // Check if a message has already been processed
  isProcessed(messageId, forwardedIds) {
    return forwardedIds.has(messageId);
  }

  markAsProcessed(messageId, forwardedIds, maxSize = 4000) {
    forwardedIds.add(messageId);
    if (forwardedIds.size > maxSize) {
      const firstKey = forwardedIds.keys().next().value;
      if (firstKey) forwardedIds.delete(firstKey);
    }
  }
}

module.exports = LidResolver;