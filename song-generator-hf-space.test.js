import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWithHuggingFaceSpace } from './song-generator-hf-space.js';

test('Hugging Face ACE-Step adapter discovers the Gradio endpoint and downloads generated audio', async () => {
  const previous = {
    url: process.env.HF_MUSIC_SPACE_URL,
    token: process.env.HF_TOKEN,
    timeout: process.env.SONG_GENERATION_TIMEOUT_MS,
    fetch: globalThis.fetch
  };
  const calls = [];
  process.env.HF_MUSIC_SPACE_URL = 'https://ace-step-ace-step-v1-5.hf.space';
  process.env.HF_TOKEN = 'unit-test-token';
  process.env.SONG_GENERATION_TIMEOUT_MS = '30000';
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      method: options.method || 'GET',
      body: options.body,
      authorization: options.headers?.authorization
    });
    assert.equal(options.headers?.authorization, 'Bearer unit-test-token');
    if (url.pathname === '/gradio_api/info') {
      const defaults = {
        0: 'acestep-v15-xl-turbo', 1: 'custom', 3: 'unknown', 6: 0, 7: '', 8: '',
        9: 'unknown', 10: 8, 11: 7, 12: true, 13: '-1', 14: null, 15: -1,
        16: 2, 17: null, 18: '', 19: 0, 20: -1,
        21: 'Fill the audio semantic mask based on the given conditions:',
        22: 1, 23: 'text2music', 24: false, 25: 0, 26: 1, 27: 3, 28: 'ode',
        29: '', 30: 'mp3', 31: 0.85, 32: true, 33: 2, 34: 0, 35: 0.9,
        36: 'NO USER INPUT', 37: true, 38: true, 39: true, 40: false,
        41: true, 42: false, 43: false, 44: 0.5, 45: 8, 46: null, 47: [], 48: false
      };
      const parameters = Array.from({ length: 49 }, (_, index) => ({
        parameter_name: ['selected_model', 'generation_mode', 'simple_query_input', 'simple_vocal_language'][index] ||
          (index === 40 ? '' : 'param_' + index),
        parameter_default: Object.prototype.hasOwnProperty.call(defaults, index) ? defaults[index] : null
      }));
      return new Response(JSON.stringify({
        named_endpoints: { '/generation_wrapper': { parameters } }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/gradio_api/call/generation_wrapper') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.data.length, 49);
      assert.equal(payload.data[0], 'acestep-v15-turbo');
      assert.equal(payload.data[1], 'custom');
      assert.equal(payload.data[4], 'Hebrew pop, energetic');
      assert.equal(payload.data[5], 'מילים לבדיקה');
      assert.equal(payload.data[9], 'he');
      assert.equal(payload.data[15], 45);
      assert.equal(payload.data[16], 1);
      assert.equal(payload.data[23], 'text2music');
      assert.equal(payload.data[30], 'mp3');
      assert.equal(payload.data[32], false);
      assert.equal(payload.data[41], true);
      assert.equal(payload.data[44], 0.5);
      assert.equal(payload.data[47].length, 0);
      assert.equal(payload.data[48], false);
      return new Response(JSON.stringify({ event_id: 'event-123' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.pathname === '/gradio_api/call/generation_wrapper/event-123') {
      return new Response('event: complete\ndata: [{"url":"/gradio_api/file=/tmp/song.mp3","path":"/tmp/song.mp3"}]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      });
    }
    if (url.pathname === '/gradio_api/file=/tmp/song.mp3') {
      return new Response(Buffer.from('mock-audio'), {
        status: 200, headers: { 'content-type': 'audio/mpeg' }
      });
    }
    throw new Error('Unexpected mock URL: ' + url.pathname);
  };
  try {
    const result = await generateWithHuggingFaceSpace({
      musicPrompt: 'Hebrew pop, energetic',
      lyrics: 'מילים לבדיקה',
      language: 'he',
      durationSeconds: 45
    });
    assert.equal(result.provider, 'huggingface-space');
    assert.equal(result.contentType, 'audio/mpeg');
    assert.equal(result.audio.toString(), 'mock-audio');
    assert.deepEqual(calls.map(call => call.path), [
      '/gradio_api/info',
      '/gradio_api/call/generation_wrapper',
      '/gradio_api/call/generation_wrapper/event-123',
      '/gradio_api/file=/tmp/song.mp3'
    ]);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries({
      HF_MUSIC_SPACE_URL: previous.url,
      HF_TOKEN: previous.token,
      SONG_GENERATION_TIMEOUT_MS: previous.timeout
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
