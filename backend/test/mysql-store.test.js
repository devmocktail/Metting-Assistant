'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MysqlStore } = require('../src/store/mysql');
const { buildConfig } = require('../src/config');

// A fake mysql2/promise pool backed by an in-memory row map, enough to exercise
// the adapter's SQL (CREATE TABLE / SELECT / upsert INSERT) without a real DB.
function fakePool() {
  const rows = new Map();
  const queries = [];
  return {
    rows,
    queries,
    async query(sql, params) {
      queries.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      if (/^CREATE TABLE/i.test(sql)) return [[]];
      if (/^SELECT/i.test(sql)) {
        const v = rows.get(params[0]);
        return [v == null ? [] : [{ v }]];
      }
      if (/^INSERT/i.test(sql)) {
        rows.set(params[0], params[1]);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
}

test('mysql store: creates table, persists, and reloads state', async () => {
  const pool = fakePool();
  const s1 = new MysqlStore({ pool });
  await s1.init();
  assert.ok(pool.queries.some((q) => /^CREATE TABLE/i.test(q)), 'ensures table');
  assert.deepEqual(s1.listUsers(), []);

  await s1.upsertUser('a@b.com', () => ({ status: 'approved' }));
  await s1.appendAudit({ ts: 't', action: 'signup', target: 'a@b.com' });

  // A fresh store over the same backing DB reloads what was written.
  const s2 = new MysqlStore({ pool });
  await s2.init();
  assert.equal(s2.getUser('a@b.com').status, 'approved');
  assert.equal(s2.listAudit(5).length, 1);
});

test('mysql store: empty table initializes empty', async () => {
  const s = new MysqlStore({ pool: fakePool() });
  await s.init();
  assert.deepEqual(s.listUsers(), []);
});

test('config requires MySQL vars in production when STORE=mysql', () => {
  assert.throws(
    () => buildConfig({ NODE_ENV: 'production', AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'c', SESSION_SECRET: 's', ADMIN_TOKEN: 't', STORE: 'mysql' }),
    /MYSQL_HOST/,
  );
  const c = buildConfig({
    NODE_ENV: 'production', AUTH_MODE: 'google', GOOGLE_CLIENT_ID: 'c', SESSION_SECRET: 's', ADMIN_TOKEN: 't',
    STORE: 'mysql', MYSQL_HOST: 'h', MYSQL_USER: 'u', MYSQL_PASSWORD: 'p', MYSQL_DATABASE: 'd',
  });
  assert.equal(c.store, 'mysql');
  assert.equal(c.mysqlDatabase, 'd');
});
