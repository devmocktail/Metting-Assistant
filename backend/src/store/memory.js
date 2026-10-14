'use strict';
const { BaseStore } = require('./base');

// In-memory only; nothing persists. Used by tests and ephemeral local runs.
class MemoryStore extends BaseStore {
  async _load() { return null; }
  async _persist(_state) {}
}

module.exports = { MemoryStore };
