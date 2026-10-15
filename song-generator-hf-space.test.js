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
  delete process.env.HF_TOKEN;
  process.env.SONG_GENERATION_TIMEOUT_MS = '30000';
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: options.method || 'GET', body: options.body });
    if (url.pathname === '/gradio_api/info') {
      return new Response(JSON.stringify({
        named_endpoints: {
          '/generation_wrapper': {
            parameters: [
              { parameter_name: 'captions' },
              { parameter_name: 'lyrics' },
              { parameter_name: 'vocal_language' },
              { parameter_name: 'audio_duration' },
              { parameter_name: 'task_type' },
              { parameter_name: 'audio_format' }
            ]
          }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/gradio_api/call/generation_wrapper') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.data[0], 'Hebrew pop, energetic');
      assert.equal(payload.data[1], 'מילים לבדיקה');
      assert.equal(payload.data[2], 'he');
      assert.equal(payload.data[3], 45);
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
      '/gradio_api/call/generate_with_progress',
      '/gradio_api/call/generate_with_progress/event-123',
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
