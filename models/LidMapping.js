const { ObjectId } = require('mongodb');

class LidMapping {
  constructor(db) {
    this.collection = db.collection('lid_mappings');
  }

  async createIndexes() {
    await this.collection.createIndex({ lid: 1 }, { unique: true });
    await this.collection.createIndex({ phoneJid: 1 });
    await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 31536000 }); // 1 year TTL
  }

  async save(lid, phoneJid) {
    const now = new Date();
    const result = await this.collection.updateOne(
      { lid },
      {
        $set: { phoneJid, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    return result;
  }

  async findByLid(lid) {
    return await this.collection.findOne({ lid });
  }

  async findByPhoneJid(phoneJid) {
    return await this.collection.findOne({ phoneJid });
  }

  async delete(lid) {
    return await this.collection.deleteOne({ lid });
  }

  async getStats() {
    return await this.collection.countDocuments();
  }
}

module.exports = LidMapping;