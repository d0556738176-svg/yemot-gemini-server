import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_TASK_CHARS = 1200;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const HIGH_IMPACT_ACTIONS = /\b(create account|open account|sign ?up|register|submit|send|publish|delete|remove|pay|purchase|buy|transfer|change password|change permissions|grant access|create user|יצירת חשבון|פתיחת חשבון|הרשמה|שליחת טופס|שלח|פרסם|מחיקה|מחק|תשלום|שלם|רכישה|העברה|שינוי סיסמה|שינוי הרשאות)\b/i;

export function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task || task.length > MAX_TASK_CHARS) {
    return { ok: false, status: 400, error: 'task_required_or_too_long' };
  }
  // This PoC is intentionally read-only. High-impact actions are never executed.
  if (HIGH_IMPACT_ACTIONS.test(task) || input.action === 'execute' || input.approved === true) {
    return { ok: false, status: 403, error: 'approval_required_and_not_supported_in_poc' };
  }
  if (input.mode && input.mode !== 'read_only') {
    return { ok: false, status: 400, error: 'only_read_only_mode_is_supported' };
  }
  return { ok: true, task, mode: 'read_only' };
}

export function createServer({ token = process.env.BRANCH5_TOKEN, adapterReady = false } = {}) {
  const requestsByIp = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'branch5-poc', mode: 'read_only', adapterReady });
    }

    if (req.method !== 'POST' || !['/api/status', '/api/task'].includes(url.pathname)) {
      return json(res, 404, { error: 'not_found' });
    }

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !equalSecret(auth.slice(7), token || '')) {
      return json(res, 401, { error: 'unauthorized' });
    }

    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (requestsByIp.get(ip) || []).filter(ts => now - ts < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) return json(res, 429, { error: 'rate_limited' });
    recent.push(now);
    requestsByIp.set(ip, recent);

    if (url.pathname === '/api/status') {
      return json(res, 200, {
        ok: true,
        service: 'branch5-poc',
        browserBridgeConnected: false,
        adapterReady,
        note: 'No Gemini request is sent by this endpoint.'
      });
    }

    let input;
    try {
      input = await readBody(req);
    } catch (error) {
      return json(res, error.status || 400, { error: error.status === 413 ? 'body_too_large' : 'invalid_json' });
    }

    const validation = validateTask(input);
    if (!validation.ok) return json(res, validation.status, { error: validation.error });

    // Fail closed until a real, live-tested adapter for the supplied extension is installed.
    if (!adapterReady) {
      return json(res, 503, {
        error: 'browser_adapter_not_ready',
        message: 'Cloud browser integration has not been verified; no task was executed.'
      });
    }
    return json(res, 501, {
      error: 'adapter_execution_not_implemented',
      message: 'The adapter execution layer is intentionally disabled in this PoC.'
    });
  });
  return server;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  if (!process.env.BRANCH5_TOKEN || process.env.BRANCH5_TOKEN.length < 32) {
    console.error('BRANCH5_TOKEN must be set to a random secret of at least 32 characters.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3005);
  createServer().listen(port, '0.0.0.0', () => {
    console.info('Branch 5 isolated PoC listening; no Yemot management configuration is loaded.');
  });
}
