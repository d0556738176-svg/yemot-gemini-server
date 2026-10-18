import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_POLL_MS = 1500;
const DEFAULT_TASK_TIMEOUT_MS = 90_000;

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[a-z0-9_]{1,40}$/i.test(code) ? code : 'adapter_execution_failed';
}

export function createWorker({
  baseUrl = process.env.BRANCH5_BASE_URL,
  token = process.env.BRANCH5_WORKER_TOKEN,
  adapter,
  pollMs = DEFAULT_POLL_MS,
  taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  fetchImpl = fetch,
  onStatus = () => {}
} = {}) {
  if (!baseUrl || !token) throw new Error('BRANCH5_BASE_URL and BRANCH5_WORKER_TOKEN are required');
  if (typeof adapter?.executeReadOnlyTask !== 'function') {
    throw new Error('A verified extension adapter is required; worker refuses to start without one');
  }
  const parsedBase = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBase.protocol)) throw new Error('Unsupported worker base URL protocol');
  if (parsedBase.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedBase.hostname)) {
    throw new Error('Worker credentials may only be sent over HTTPS, except to loopback');
  }

  let stopped = false;
  let activeAbortController = null;

  async function post(path, body, signal) {
    const response = await fetchImpl(new URL(path, parsedBase), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'cache-control': 'no-store'
      },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      const error = new Error(`worker_api_http_${response.status}`);
      error.code = `worker_api_http_${response.status}`;
      throw error;
    }
    return response.json();
  }

  async function runOnce() {
    const claim = await post('/api/worker/claim', {});
    if (!claim.task) return false;

    const { id, task, mode } = claim.task;
    let status = 'failed';
    let result = 'No verified result was returned.';
    const controller = new AbortController();
    activeAbortController = controller;
    const timeout = setTimeout(() => controller.abort(new Error('task_timeout')), taskTimeoutMs);
    try {
      if (mode !== 'read_only' || typeof task !== 'string' || !task.trim()) {
        throw Object.assign(new Error('invalid_claimed_task'), { code: 'invalid_claimed_task' });
      }
      const adapterResult = await adapter.executeReadOnlyTask({ id, task, signal: controller.signal });
      if (!adapterResult || adapterResult.verified !== true || typeof adapterResult.text !== 'string') {
        throw Object.assign(new Error('unverified_adapter_result'), { code: 'unverified_adapter_result' });
      }
      status = 'completed';
      result = adapterResult.text.slice(0, 4000);
    } catch (error) {
      result = `Task not completed: ${safeErrorCode(error)}`;
    } finally {
      clearTimeout(timeout);
      activeAbortController = null;
    }

    // Only a result explicitly marked verified by the adapter may be reported completed.
    await post('/api/worker/result', { id, status, result });
    onStatus({ id, status });
    return true;
  }

  async function start() {
    onStatus({ status: 'started' });
    while (!stopped) {
      try {
        const didWork = await runOnce();
        if (!didWork) await sleep(pollMs);
      } catch (error) {
        onStatus({ status: 'retrying', error: safeErrorCode(error) });
        await sleep(pollMs);
      }
    }
    onStatus({ status: 'stopped' });
  }

  function stop() {
    stopped = true;
    activeAbortController?.abort(new Error('worker_stopped'));
  }

  return { start, stop, runOnce };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  console.error('No extension adapter is bundled. Import createWorker with a separately verified adapter; refusing to start.');
  process.exitCode = 1;
}
