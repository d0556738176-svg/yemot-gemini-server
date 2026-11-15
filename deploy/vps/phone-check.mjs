// Checks the phone sound chain of extension 2 on this server's own ffmpeg.
//   node deploy/vps/phone-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
const EXT2 = '/opt/yemot/ext2';
const ff = (await import(EXT2 + '/node_modules/ffmpeg-static/index.js')).default;
const { preparePhoneAudio } = await import(EXT2 + '/youtube-phone-audio.js');
const d = mkdtempSync('/tmp/phone-');
execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-f', 'lavfi', '-i', 'anoisesrc=d=8:a=0.05', '-filter_complex', 'amix=inputs=2', d + '/src.wav']);
const r = await preparePhoneAudio(d + '/src.wav', d + '/out.wav', {});
console.log(r.bytes > 100000 && r.soxr ? 'PASS phone sound chain' : 'FAIL phone sound chain', JSON.stringify({ lufs: r.measuredLufs, gain: r.gainDb, soxr: r.soxr, sec: r.durationSec }));
rmSync(d, { recursive: true, force: true });
