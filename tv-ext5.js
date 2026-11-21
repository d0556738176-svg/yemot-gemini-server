// Owner, 19.11: the live channels move to main-menu extension 5, every channel
// in its own extension, and replays by hour go in 5/9:
//   /5        menu of the channels (1-8), 9 = replays, * = main menu
//   /5/1../5/8  one live channel each
//   /5/9      replays: choose a channel
//   /5/9/1../5/9/8  replays of one channel: choose the hour (00-23)
// Every folder is an API extension of this app (extension 2's handler, which
// owns the live relay), told which part to play by api_add_0=tv=<part>.
// Written at every start from PUBLIC_BASE_URL, so an IP change needs no
// manual fix. The marker ext5_tv=yes tells the main app to leave /5 alone.
import { TV_CHANNELS, RADIO_CHANNELS } from './branch2-tv.js';

export const EXT5_MARK = 'ext5_tv=yes';

export function ext5Layout(publicUrl) {
  const link = String(publicUrl || '').replace(/\/$/, '') + '/yemot-youtube';
  const ini = (tv, title) => ['type=api', 'api_link=' + link, 'api_add_0=tv=' + tv, 'title=' + title, EXT5_MARK].join('\n') + '\n';
  const out = [['ivr2:/5', ini('menu', 'שידורים חיים')], ['ivr2:/5/9', ini('replay', 'שידורים חוזרים')]];
  for (const ch of TV_CHANNELS) {
    out.push(['ivr2:/5/' + ch.key, ini('live' + ch.key, ch.title)]);
    out.push(['ivr2:/5/9/' + ch.key, ini('replay' + ch.key, 'שידורים חוזרים - ' + ch.title)]);
  }
  // Owner, 21.11: extension 10 = live radio (no replays), one extension each.
  out.push(['ivr2:/10', ini('radio', 'רדיו חי')]);
  for (const ch of RADIO_CHANNELS) out.push(['ivr2:/10/' + ch.digit, ini('radio' + ch.digit, ch.title)]);
  return out;
}

// Owner, 21.11: extension 10 in the main menu needs a two-digit menu. Yemot:
// digits=2 waits for a second digit (timeout seconds after the last press,
// default 7 - set to 2), text_extensions=yes with ExtensionNumbersAndAssociations.ini
// keeps the one-digit folders reachable as 01..09 too. Every other line of the
// main menu's settings is kept; the settings before the change are saved once
// as ext_before_10.ini, so going back is one copy.
export const TWO_DIGIT_LINES = ['digits=2', 'timeout=2', 'text_extensions=yes'];
export const ASSOC = Array.from({ length: 10 }, (_, i) => '0' + i + '=' + i).join('\n') + '\n';
export function withTwoDigits(ini) {
  const keep = String(ini || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(l => l && !/^(digits|timeout|text_extensions)=/.test(l));
  return [...keep, ...TWO_DIGIT_LINES].join('\n') + '\n';
}
export const mainMenuStatus = { at: null };
export async function setupMainMenu10(io, log = console) {
  const st = { at: new Date().toISOString() };
  try {
    const before = await io.getText('ivr2:/ext.ini');
    if (before == null) throw new Error('main menu settings not readable');
    if (!/^\s*type=menu\s*$/m.test(before)) { st.skipped = 'main menu is not type=menu'; Object.assign(mainMenuStatus, st); return st; }
    const assocBefore = await io.getText('ivr2:/ExtensionNumbersAndAssociations.ini');
    const assocLines = String(assocBefore || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const assocWant = [...assocLines.filter(l => !/^0\d=/.test(l)), ...ASSOC.trim().split('\n')].join('\n') + '\n';
    if (norm(assocBefore) !== norm(assocWant)) await io.putText('ivr2:/ExtensionNumbersAndAssociations.ini', assocWant);
    const want = withTwoDigits(before);
    if (norm(before) !== norm(want)) {
      if (!(await io.getText('ivr2:/ext_before_10.ini'))) await io.putText('ivr2:/ext_before_10.ini', before);
      await io.putText('ivr2:/ext.ini', want);
    }
    const after = await io.getText('ivr2:/ext.ini');
    st.ok = norm(after) === norm(want) && norm(await io.getText('ivr2:/ExtensionNumbersAndAssociations.ini')) === norm(assocWant);
    st.lines = norm(after).split('\n').filter(l => /^(type|digits|timeout|text_extensions|hash_extension)=/.test(l));
  } catch (e) { st.error = String(e?.message || e).slice(0, 160); }
  Object.assign(mainMenuStatus, st);
  log.info?.('[EXT10] main menu two-digit', st);
  return st;
}

const norm = t => String(t || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean).join('\n');

export const ext5Status = { at: null, folders: [] };

// io: { getText(what) -> string|null, putText(what, contents), update(path, settings) }
export async function setupExt5(publicUrl, io, log = console) {
  ext5Status.at = new Date().toISOString(); ext5Status.folders = [];
  // Parents first, so a sub-folder is never written into a missing folder.
  for (const [path, want] of ext5Layout(publicUrl)) {
    const row = { path: path.replace('ivr2:', ''), ok: false };
    try {
      const before = await io.getText(path + '/ext.ini');
      if (norm(before) === norm(want)) { row.ok = true; row.same = true; ext5Status.folders.push(row); continue; }
      row.before = String(before || '').split('\n').find(l => /^type=/.test(l.trim())) || null;
      await io.putText(path + '/ext.ini', want);
      let after = await io.getText(path + '/ext.ini');
      if (norm(after) !== norm(want) && io.update) {
        // A folder Yemot has not created yet: create it with its settings.
        const settings = Object.fromEntries(want.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
        await io.update(path, settings).catch(() => {});
        await io.putText(path + '/ext.ini', want).catch(() => {});
        after = await io.getText(path + '/ext.ini');
      }
      row.ok = norm(after) === norm(want);
    } catch (e) { row.error = String(e?.message || e).slice(0, 160); }
    ext5Status.folders.push(row);
  }
  const bad = ext5Status.folders.filter(f => !f.ok);
  log.info?.('[EXT5 TV] Yemot extension 5 set', { folders: ext5Status.folders.length, failed: bad.map(f => f.path) });
  return ext5Status;
}
