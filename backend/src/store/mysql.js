'use strict';
const { BaseStore } = require('./base');

// Persists the whole state as one JSON row in a MySQL/MariaDB table (matches the
// json/upstash adapters). Good for Hostinger Web Apps, where the DB survives Git
// redeploys. The data is tiny, so a single-row document keeps it simple and
// consistent with the other stores.
const STATE_KEY = 'meeting-assistant:state:v1';

class MysqlStore extends BaseStore {
  constructor(opts = {}) {
    super();
    this.key = opts.key || STATE_KEY;
    this._opts = opts;
    this._pool = null;
  }

  async _getPool() {
    if (this._pool) return this._pool;
    // Injectable for tests; otherwise build a real pool lazily.
    if (this._opts.pool) {
      this._pool = this._opts.pool;
      return this._pool;
    }
    const mysql = require('mysql2/promise');
    this._pool = mysql.createPool({
      host: this._opts.host,
      port: this._opts.port || 3306,
      user: this._opts.user,
      password: this._opts.password,
      database: this._opts.database,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    });
    return this._pool;
  }

  async init() {
    const pool = await this._getPool();
    await pool.query(
      'CREATE TABLE IF NOT EXISTS app_state (k VARCHAR(190) NOT NULL PRIMARY KEY, v LONGTEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    return super.init();
  }

  async _load() {
    const pool = await this._getPool();
    const [rows] = await pool.query('SELECT v FROM app_state WHERE k = ? LIMIT 1', [this.key]);
    if (!rows || rows.length === 0 || rows[0].v == null) return null;
    try {
      return JSON.parse(rows[0].v);
    } catch {
      return null;
    }
  }

  async _persist(state) {
    const pool = await this._getPool();
    await pool.query(
      'INSERT INTO app_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [this.key, JSON.stringify(state)],
    );
  }
}

module.exports = { MysqlStore, STATE_KEY };
