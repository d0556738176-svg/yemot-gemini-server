import { writeFile } from 'node:fs/promises';
import { generateWithHuggingFaceSpace } from './song-generator-hf-space.js';

process.env.HF_MUSIC_SPACE_URL ||= 'https://ace-step-ace-step-v1-5.hf.space';
process.env.SONG_GENERATION_TIMEOUT_MS = '300000';

if (!String(process.env.HF_TOKEN || '').trim()) {
  throw new Error('HF_TOKEN GitHub Secret is required for this isolated REST test');
}

try {
  const result = await generateWithHuggingFaceSpace({
    musicPrompt: 'Upbeat Israeli pop, modern synths, warm bass, punchy drums, clear solo vocal singing Hebrew lyrics',
    lyrics: '[Verse 1]\nנוסעים קדימה, האור נדלק\nקצב בלב וכל רגע מתחזק\n[Chorus]\nעוד צעד ועוד חלום\nשרים ביחד עד סוף היום',
    language: 'he',
    durationSeconds: 30
  });
  const audio = result.audio;
  const hasId3Header = audio.subarray(0, 3).toString('ascii') === 'ID3';
  const hasMpegFrameHeader = audio.length > 1 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  if (!result.contentType.startsWith('audio/') && !result.contentType.includes('octet-stream')) {
    throw new Error('Unexpected audio content type: ' + result.contentType);
  }
  if (audio.length < 10000 || (!hasId3Header && !hasMpegFrameHeader)) {
    throw new Error('Generated response did not look like a valid MP3 audio file');
  }
  const outputPath = 'branch4-ace-step-rest-hebrew-test.mp3';
  await writeFile(outputPath, audio);
  console.log('LIVE_ACE_STEP_SPACE_MUSIC_TEST_OK', JSON.stringify({
    provider: result.provider,
    model: result.model,
    contentType: result.contentType,
    bytes: audio.length,
    mp3HeaderValid: true,
    outputPath
  }));
} catch (error) {
  console.error('LIVE_ACE_STEP_SPACE_MUSIC_TEST_FAILED', String(error?.message || error).slice(0, 700));
  process.exitCode = 1;
}
