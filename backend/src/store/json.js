'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { BaseStore } = require('./base');

// Persists the whole state to a JSON file with an atomic write (temp + rename).
class JsonStore extends BaseStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.dir = path.dirname(filePath);
  }

  async _load() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null; // first run
      throw err;
    }
  }

  async _persist(state) {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = JSON.stringify(state, null, 2);
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, this.filePath);
  }
}

module.exports = { JsonStore };
