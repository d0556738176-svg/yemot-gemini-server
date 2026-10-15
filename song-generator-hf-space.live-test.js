import { generateWithHuggingFaceSpace } from './song-generator-hf-space.js';

process.env.HF_MUSIC_SPACE_URL ||= 'https://ace-step-ace-step-v1-5.hf.space';
process.env.SONG_GENERATION_TIMEOUT_MS = '300000';

try {
  const result = await generateWithHuggingFaceSpace({
    musicPrompt: 'Upbeat Hebrew pop, bright synths, punchy drums, catchy melody, warm vocal performance',
    lyrics: '[Verse]\nנוסעים קדימה, האור נדלק\nקצב בלב וכל רגע מתחזק\n[Chorus]\nעוד צעד ועוד חלום\nשרים ביחד עד סוף היום',
    language: 'he',
    durationSeconds: 30
  });
  const audio = result.audio;
  const hasId3Header = audio.subarray(0, 3).toString('ascii') === 'ID3';
  const hasMpegFrameHeader = audio.length > 1 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  if (result.contentType !== 'audio/mpeg' && !result.contentType.includes('application/octet-stream')) {
    throw new Error('Unexpected audio content type: ' + result.contentType);
  }
  if (audio.length < 10000 || (!hasId3Header && !hasMpegFrameHeader)) {
    throw new Error('Generated response did not look like a valid MP3 audio file');
  }
  console.log('LIVE_HF_MUSIC_TEST_OK', JSON.stringify({
    provider: result.provider,
    model: result.model,
    contentType: result.contentType,
    bytes: audio.length,
    mp3HeaderValid: true
  }));
} catch (error) {
  console.error('LIVE_HF_MUSIC_TEST_FAILED', String(error?.message || error).slice(0, 500));
  process.exitCode = 1;
}
