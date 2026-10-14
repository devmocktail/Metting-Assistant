'use strict';
const path = require('node:path');
const { MemoryStore } = require('./memory');
const { JsonStore } = require('./json');
const { UpstashStore } = require('./upstash');

// Picks a store adapter from config. Does not call init(); the caller awaits that.
function createStore(config) {
  switch ((config.store || 'json').toLowerCase()) {
    case 'memory':
      return new MemoryStore();
    case 'upstash':
      return new UpstashStore(config.upstashUrl, config.upstashToken);
    case 'json':
    default:
      return new JsonStore(path.join(config.dataDir || './data', 'users.json'));
  }
}

module.exports = { createStore, MemoryStore, JsonStore, UpstashStore };
