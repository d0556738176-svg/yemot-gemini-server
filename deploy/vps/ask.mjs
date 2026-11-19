// Owner's live check of extensions 1 and 3 (19.11). Read-only for the system:
// it writes the questions under a long random name and prints an address;
// opening the address runs them as one simulated call in the running code.
//   node /opt/yemot/main/deploy/vps/ask.mjs 3 "question one" "question two" ...
//   (no questions = the standard set)
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const branch = process.argv[2] === '1' ? '1' : '3';
const STANDARD = [
  'מה נשמע',
  'אתה מוריד רק מיוטיוב?',
  'מתי סוף זמן קריאת שמע של הגרא במשוב עוצם',
  'איפה הבית כנסת הקרוב ביותר לחוף הנפרד באשקלון',
  'איך נקרא הצמד שתמר יהלומי שרה איתו',
  'תן לי כמה טיפים לשינה טובה',
  'מה שאלתי אותך בתחילת השיחה?',
  'תמצאי לי ביוטיוב שירים של ישי ריבו',
  'תורידי את אחת ושלוש',
  'שלוש',
  'בוא נכתוב שיר קצר לכבוד שבת בקול של ילד עם גיטרה',
  'עכשיו תיצרי את השיר',
  'שלוש',
  'שיחה חדשה'
];
const questions = process.argv.slice(3).length ? process.argv.slice(3) : STANDARD;
const dir = '/var/lib/yemot-report';
mkdirSync(dir, { recursive: true, mode: 0o700 });
const name = randomBytes(12).toString('hex');
writeFileSync(dir + '/' + name + '.ask', JSON.stringify({ branch, questions }), { mode: 0o600 });
const env = readFileSync('/opt/yemot/main.env', 'utf8').match(/^PUBLIC_BASE_URL="([^"]*)"/m)?.[1] || '';
console.log('CHECK READY, open: ' + env.replace(/\/+$/, '') + '/owner-check/' + name);
console.log('then read:  /owner-report/' + name);
console.log('code: ' + name.match(/.{1,4}/g).join(' '));
