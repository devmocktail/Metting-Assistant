'use strict';
// Minimal .env loader (no dependency). Only sets keys not already in process.env,
// so real environment variables from the host always win. Supports KEY=VALUE,
// blank lines, # comments, and single/double quoted values.
const fs = require('node:fs');
const path = require('node:path');

function parse(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnv(file) {
  const envPath = file || path.join(process.cwd(), '.env');
  let contents;
  try {
    contents = fs.readFileSync(envPath, 'utf8');
  } catch {
    return {}; // no .env file is fine
  }
  const parsed = parse(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

module.exports = { loadEnv, parse };
