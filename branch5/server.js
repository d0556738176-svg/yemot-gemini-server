import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_TASK_CHARS = 1200;
const MAX_RESULT_CHARS = 4000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const JOB_TTL_MS = 5 * 60_000;
const MAX_QUEUE_SIZE = 20;

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
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const HIGH_IMPACT_ACTIONS = /\\b(create account|open account|sign ?up|register|submit|send|publish|delete|remove|pay|purchase|buy|transfer|change password|change permissions|grant access|create user)\\b/i;
const HIGH_IMPACT_HEBREW = ['יצירת חשבון', 'פתיחת חשבון', 'הרשמה', 'שליחת טופס', 'שלח', 'פרסם', 'מחיקה', 'מחק', 'תשלום', 'שלם', 'רכישה', 'העברה', 'שינוי סיסמה', 'שינוי הרשאות'];

export function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task || task.length > MAX_TASK_CHARS) {
    return { ok: false, status: 400, error: 'task_required_or_too_long' };
  }
  if (HIGH_IMPACT_ACTIONS.test(task) || HIGH_IMPACT_HEBREW.some(term => task.includes(term)) || input.action === 'execute' || input.approved === true) {
    return { ok: false, status: 403, error: 'approval_required_and_not_supported_in_poc' };
  }
  if (input.mode && input.mode !== 'read_only') {
    return { ok: false, status: 400, error: 'only_read_only_mode_is_supported' };
  }
  return { ok: true, task, mode: 'read_only' };
}

function pruneJobs(jobs, now) {
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS || job.status === 'completed' || job.status === 'failed') {
      jobs.delete(id);
    }
  }
}

export function createServer({
  token = process.env.BRANCH5_TOKEN,
  workerToken = process.env.BRANCH5_WORKER_TOKEN,
  adapterReady = false,
  workerProtocolEnabled = false
} = {}) {
  const requestsByIp = new Map();
  const jobs = new Map();
  const idempotency = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'branch5-poc',
        mode: 'read_only',
        adapterReady: false,
        workerProtocolEnabled
      });
    }

    const protectedRoute = req.method === 'POST' &&
      ['/api/status', '/api/task', '/api/worker/claim', '/api/worker/result'].includes(url.pathname);
    if (!protectedRoute) return json(res, 404, { error: 'not_found' });

    const isWorkerRoute = url.pathname.startsWith('/api/worker/');
    const expectedToken = isWorkerRoute ? (workerToken || '') : (token || '');
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !equalSecret(auth.slice(7), expectedToken)) {
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
        adapterReady: false,
        workerProtocolEnabled,
        queuedJobs: [...jobs.values()].filter(job => job.status === 'queued').length,
        note: 'No Gemini request is sent by this endpoint.'
      });
    }

    let input;
    try {
      input = await readBody(req);
    } catch (error) {
      return json(res, error.status || 400, { error: error.status === 413 ? 'body_too_large' : 'invalid_json' });
    }

    pruneJobs(jobs, Date.now());

    if (url.pathname === '/api/worker/claim') {
      if (!workerProtocolEnabled) return json(res, 503, { error: 'worker_protocol_disabled' });
      const next = [...jobs.values()].find(job => job.status === 'queued');
      if (!next) return json(res, 200, { task: null });
      next.status = 'claimed';
      next.claimedAt = Date.now();
      return json(res, 200, {
        task: { id: next.id, task: next.task, mode: next.mode, deadline: next.createdAt + JOB_TTL_MS }
      });
    }

    if (url.pathname === '/api/worker/result') {
      if (!workerProtocolEnabled) return json(res, 503, { error: 'worker_protocol_disabled' });
      const id = typeof input.id === 'string' ? input.id : '';
      const status = input.status;
      const result = typeof input.result === 'string' ? input.result : '';
      const job = jobs.get(id);
      if (!job || job.status !== 'claimed') return json(res, 404, { error: 'claimed_task_not_found' });
      if (!['completed', 'failed'].includes(status) || result.length > MAX_RESULT_CHARS) {
        return json(res, 400, { error: 'invalid_task_result' });
      }
      job.status = status;
      job.finishedAt = Date.now();
      job.result = result;
      return json(res, 200, { ok: true, id: job.id, status: job.status });
    }

    const validation = validateTask(input);
    if (!validation.ok) return json(res, validation.status, { error: validation.error });
    if (!workerProtocolEnabled) {
      return json(res, 503, {
        error: 'browser_adapter_not_ready',
        message: 'Cloud browser integration has not been verified; no task was executed.'
      });
    }
    if ([...jobs.values()].filter(job => job.status === 'queued' || job.status === 'claimed').length >= MAX_QUEUE_SIZE) {
      return json(res, 503, { error: 'task_queue_full' });
    }

    const key = req.headers['idempotency-key'];
    if (typeof key === 'string' && key.length > 0 && key.length <= 128) {
      const existingId = idempotency.get(key);
      const existing = existingId ? jobs.get(existingId) : null;
      if (existing && Date.now() - existing.createdAt <= JOB_TTL_MS) {
        return json(res, 202, { id: existing.id, status: existing.status, duplicate: true });
      }
    }

    const id = randomUUID();
    const job = {
      id,
      task: validation.task,
      mode: validation.mode,
      status: 'queued',
      createdAt: Date.now()
    };
    jobs.set(id, job);
    if (typeof key === 'string' && key.length > 0 && key.length <= 128) idempotency.set(key, id);
    return json(res, 202, { id, status: job.status, mode: job.mode });
  });

  return server;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  if (!process.env.BRANCH5_TOKEN || process.env.BRANCH5_TOKEN.length < 32) {
    console.error('BRANCH5_TOKEN must be set to a random secret of at least 32 characters.');
    process.exit(1);
  }
  if (!process.env.BRANCH5_WORKER_TOKEN || process.env.BRANCH5_WORKER_TOKEN.length < 32) {
    console.error('BRANCH5_WORKER_TOKEN must be set to a separate random secret of at least 32 characters.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3005);
  createServer().listen(port, '0.0.0.0', () => {
    console.info('Branch 5 isolated PoC listening; no Yemot management configuration is loaded.');
  });
}
