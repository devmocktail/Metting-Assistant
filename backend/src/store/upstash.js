'use strict';
const { BaseStore } = require('./base');

// Persists the whole state as one JSON string in Upstash Redis via its REST API.
// Free, persistent, and dependency-free (uses global fetch). Fine for a
// single-instance POC; the server process is the only writer.
const STATE_KEY = 'meeting-assistant:state:v1';

class UpstashStore extends BaseStore {
  constructor(url, token, key = STATE_KEY) {
    super();
    if (!url || !token) throw new Error('UpstashStore requires url and token');
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.key = key;
  }

  async _cmd(args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upstash ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data && data.error) throw new Error(`Upstash error: ${data.error}`);
    return data ? data.result : undefined;
  }

  async _load() {
    const result = await this._cmd(['GET', this.key]);
    if (result === null || result === undefined) return null;
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async _persist(state) {
    await this._cmd(['SET', this.key, JSON.stringify(state)]);
  }
}

module.exports = { UpstashStore, STATE_KEY };
