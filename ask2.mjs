// Read-only for the system (19.11): the owner's example questions as two
// simulated calls (extension 3, then extension 1) through the running code's
// /owner-check. No real call, no download, no hand-off. Prints two codes.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const sets = {
  '3': ['מה השיעור האחרון של גואל אלקריף ביוטיוב', 'האם רמי לוי בבית שמש בקניון השדרה פתוח עכשיו', 'אני נמצא בבית שמש ברמה א איפה יש עכשיו בית מרקחת פתוחה', 'אני ברמה א בבית שמש וצריך להגיע לתחנה המרכזית בירושלים, איך נוסעים באוטובוס ואיך ברכב ובאיזה כבישים', 'איפה מוכרים את הספר נפש החיים בבית שמש', 'מה המספר של הרב דביר בעניין מכונות תספורת', 'איזה סרטונים יצאו לאחרונה בערוץ 14', 'תשמיע לי את ערוץ 14 בשידור חי', 'מה שאלתי אותך בתחילת השיחה'],
  '1': ['מה השיעור האחרון של גואל אלקריף ביוטיוב', 'האם רמי לוי בבית שמש בקניון השדרה פתוח עכשיו']
};
const dir = '/var/lib/yemot-report';
mkdirSync(dir, { recursive: true, mode: 0o700 });
const base = (readFileSync('/opt/yemot/main.env', 'utf8').match(/^PUBLIC_BASE_URL="([^"]*)"/m)?.[1] || '').replace(/\/+$/, '');
const codes = [];
for (const [branch, questions] of Object.entries(sets)) {
  const name = randomBytes(12).toString('hex');
  writeFileSync(dir + '/' + name + '.ask', JSON.stringify({ branch, questions }), { mode: 0o600 });
  const r = await fetch(base + '/owner-check/' + name).then(x => x.text()).catch(e => 'ERR ' + e.message);
  console.log('extension ' + branch + ': ' + r.slice(0, 80));
  codes.push(name.match(/.{1,4}/g).join(' '));
}
console.log('ASK CODES: ' + codes.join('  |  '));
