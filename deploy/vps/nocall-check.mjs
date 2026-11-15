// The system working alone, with no caller on the line (as after hanging up):
//  1) extension 2 downloads a song in the background (start, then only ask),
//  2) extension 4 makes a song on GitHub; the finished song is delivered to
//     the main server with nobody waiting (the "caller hung up" path) and
//     lands in extensions 4 and 7.
//   node deploy/vps/nocall-test.mjs [videoId]
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
for (const f of ['/opt/yemot/main.env', '/opt/yemot/ext2.env']) for (const l of readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)="(.*)"$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const vid = process.argv[2] || 'HHkeMlB4yNI';
const media = new URL('http://127.0.0.1:3001/api/ext3/media');
for (const [k, v] of Object.entries({ secret: process.env.EXT3_MEDIA_SECRET, videoId: vid, mode: 'audio', title: 'בדיקה בלי שיחה', start: '1' })) media.searchParams.set(k, v);
const st = await (await fetch(media)).json();
console.log('EXT2 download started with no call:', st.audio?.status, st.audio?.stage || '');
const { dispatchSongJob } = await import('../../song-cloud.js');
const jobId = randomUUID();
await dispatchSongJob(jobId, {
  title: 'אור התורה', language: 'he', duration: 75,
  prompt: 'warm Jewish acoustic song, gentle guitar and strings, adult male voice, uplifting, clear Hebrew vocals',
  lyrics: '[verse]\nבבוקר אני פותח את הספר\nוהאור מתוך הדף מאיר\nכל מילה היא אוצר יקר\nכל שורה מלמדת אותי לשיר\n\n[chorus]\nאור התורה, אור התורה\nמאיר לי את הדרך בכל שעה\nאור התורה, אור התורה\nבלב שלי שמחה גדולה\n',
  caller: 'test', callId: 'nocall-' + jobId.slice(0, 8)
});
console.log('EXT4 song sent to GitHub with no call, job', jobId);
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 15000));
  const s = await (await fetch(media.href.replace('start=1', 'start=0'))).json().catch(() => null);
  console.log('EXT2', Math.round((i + 1) * 15 / 60 * 10) / 10, 'min:', s?.audio?.status, s?.audio?.stage || '', s?.audio?.paths ? s.audio.paths.length + ' files' : '');
  if (s?.audio?.status === 'ready' || s?.audio?.status === 'failed') break;
}
console.log('The song: watch for AUDIO_RECEIVED / ORPHAN_SONG_DELIVERY in the main log in ~30 minutes.');
