'use strict';
// Shared store logic. Subclasses only implement _load()/_persist(state).
// The whole state ({users, audit}) is small, so it is cached in memory after
// init() and the full document is persisted on each write. Writes are chained so
// two concurrent mutations can never interleave their persists.

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const AUDIT_CAP = 1000;

class BaseStore {
  constructor() {
    this.state = { users: {}, audit: [] };
    this._saveChain = Promise.resolve();
    this.ready = false;
  }

  async init() {
    const loaded = await this._load();
    if (loaded && typeof loaded === 'object') {
      this.state = {
        users: loaded.users && typeof loaded.users === 'object' ? loaded.users : {},
        audit: Array.isArray(loaded.audit) ? loaded.audit : [],
      };
    }
    this.ready = true;
    return this;
  }

  // Override in subclasses.
  async _load() { return null; }
  async _persist(_state) {}

  _save() {
    const run = this._saveChain.then(() => this._persist(this.state));
    // Keep the chain healthy even if this persist fails, but still surface the
    // error to the caller that awaited this particular save.
    this._saveChain = run.catch(() => {});
    return run;
  }

  getUser(email) {
    const u = this.state.users[normEmail(email)];
    return u ? { ...u } : null;
  }

  listUsers() {
    return Object.values(this.state.users).map((u) => ({ ...u }));
  }

  // Atomic read-modify-write for one user. mutator(existingOrNull) -> newUser|null.
  async upsertUser(email, mutator) {
    const key = normEmail(email);
    const existing = this.state.users[key] ? { ...this.state.users[key] } : null;
    const next = mutator(existing);
    if (!next) return null;
    next.email = key;
    this.state.users[key] = next;
    await this._save();
    return { ...next };
  }

  async deleteUser(email) {
    const key = normEmail(email);
    if (!this.state.users[key]) return false;
    delete this.state.users[key];
    await this._save();
    return true;
  }

  async appendAudit(entry) {
    this.state.audit.push(entry);
    if (this.state.audit.length > AUDIT_CAP) {
      this.state.audit = this.state.audit.slice(-AUDIT_CAP);
    }
    await this._save();
  }

  listAudit(limit = 200) {
    const a = this.state.audit;
    const n = Math.max(0, Math.min(limit, a.length));
    return a.slice(a.length - n).reverse();
  }
}

module.exports = { BaseStore, normEmail };
