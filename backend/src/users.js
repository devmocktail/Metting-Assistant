'use strict';
const { normEmail } = require('./store/base');
const { isEmail, httpError } = require('./identity');

const STATUSES = ['pending', 'approved', 'banned'];

function isAdminEmail(config, email) {
  return config.adminEmails.includes(normEmail(email));
}

// The single source of truth for "can this account use the tool right now".
function isAllowed(config, user) {
  if (!user) return false;
  if (isAdminEmail(config, user.email)) return true;
  return user.status === 'approved';
}

function summary(user) {
  if (!user) return null;
  return {
    email: user.email,
    name: user.name || '',
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSeenAt: user.lastSeenAt,
    approvedBy: user.approvedBy || null,
    notes: user.notes || '',
    command: user.command || null,
  };
}

// Called after a verified identity. Creates the record (status "pending", or
// "approved" if the email is an admin) or updates an existing one, and refreshes
// lastSeenAt. Returns the stored user.
async function signIn(store, config, identity) {
  const email = normEmail(identity.email);
  if (!isEmail(email)) throw httpError('invalid email', 400);
  const admin = isAdminEmail(config, email);
  const now = new Date().toISOString();
  let created = false;

  const user = await store.upsertUser(email, (existing) => {
    if (!existing) {
      created = true;
      return {
        email,
        name: identity.name || '',
        googleSub: identity.sub || '',
        status: admin ? 'approved' : 'pending',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        approvedBy: admin ? 'system:admin-email' : null,
        notes: '',
      };
    }
    const updated = {
      ...existing,
      name: identity.name || existing.name || '',
      googleSub: identity.sub || existing.googleSub || '',
      lastSeenAt: now,
      updatedAt: now,
    };
    // An admin email is always kept usable.
    if (admin && updated.status !== 'approved') {
      updated.status = 'approved';
      updated.approvedBy = 'system:admin-email';
    }
    return updated;
  });

  if (created) {
    await store.appendAudit({ ts: now, actor: email, action: 'signup', target: email, detail: `status=${user.status}` });
  }
  return user;
}

// Lightweight lastSeen refresh for heartbeats; returns the current user or null.
async function touch(store, email) {
  const key = normEmail(email);
  if (!store.getUser(key)) return null;
  const now = new Date().toISOString();
  return store.upsertUser(key, (existing) => (existing ? { ...existing, lastSeenAt: now } : null));
}

// Admin: set a user's status. Creates the record if missing (pre-approve or
// pre-ban an email before its first sign-in). Returns the stored user.
async function setStatus(store, config, actorEmail, targetEmail, status, notes) {
  const email = normEmail(targetEmail);
  if (!isEmail(email)) throw httpError('invalid target email', 400);
  if (!STATUSES.includes(status)) throw httpError(`status must be one of ${STATUSES.join(', ')}`, 400);
  const now = new Date().toISOString();

  const user = await store.upsertUser(email, (existing) => {
    if (!existing) {
      return {
        email,
        name: '',
        googleSub: '',
        status,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
        approvedBy: status === 'approved' ? normEmail(actorEmail) : null,
        notes: notes || '',
        command: null,
      };
    }
    return {
      ...existing,
      status,
      updatedAt: now,
      approvedBy: status === 'approved' ? normEmail(actorEmail) : existing.approvedBy || null,
      notes: notes !== undefined ? notes : existing.notes || '',
      // A status change cancels any pending remote-uninstall command.
      command: null,
    };
  });

  await store.appendAudit({ ts: now, actor: normEmail(actorEmail), action: `set:${status}`, target: email, detail: notes || '' });
  return user;
}

// Admin: flag a user's device to self-remove on its next heartbeat. Also bans
// them so access is cut immediately. Returns the stored user.
async function uninstall(store, config, actorEmail, targetEmail) {
  const email = normEmail(targetEmail);
  if (!isEmail(email)) throw httpError('invalid target email', 400);
  const now = new Date().toISOString();
  const user = await store.upsertUser(email, (existing) => {
    const base = existing || { email, name: '', googleSub: '', createdAt: now, lastSeenAt: null, approvedBy: null, notes: '' };
    return { ...base, status: 'banned', command: 'uninstall', updatedAt: now };
  });
  await store.appendAudit({ ts: now, actor: normEmail(actorEmail), action: 'uninstall', target: email, detail: '' });
  return user;
}

async function remove(store, actorEmail, targetEmail) {
  const email = normEmail(targetEmail);
  const existed = await store.deleteUser(email);
  if (existed) {
    await store.appendAudit({ ts: new Date().toISOString(), actor: normEmail(actorEmail), action: 'delete', target: email, detail: '' });
  }
  return existed;
}

function listUsers(store, config) {
  return store
    .listUsers()
    .map((u) => ({ ...summary(u), admin: isAdminEmail(config, u.email), allowed: isAllowed(config, u) }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

module.exports = {
  STATUSES,
  uninstall,
  isAdminEmail,
  isAllowed,
  summary,
  signIn,
  touch,
  setStatus,
  remove,
  listUsers,
};
