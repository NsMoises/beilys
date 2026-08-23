const { MongoClient } = require('mongodb');

class Database {
  constructor(uri, dbName) {
    this.uri = uri;
    this.dbName = dbName;
    this.client = null;
    this.db = null;
  }

  async connect() {
    if (this.client) return this.db;

    this.client = new MongoClient(this.uri, {
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    await this.client.connect();
    this.db = this.client.db(this.dbName);
    
    // Test connection
    await this.db.admin().ping();
    console.log('MongoDB connected successfully');
    
    return this.db;
  }

  getDb() {
    return this.db;
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }
}

module.exports = Database;