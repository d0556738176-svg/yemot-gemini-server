// Owner's rule (06.11): in every extension, * returns to the main menu.
// Playback extensions get Yemot's documented key setting
//   control_play*=go_to_folder + playfile_control_play_*_goto=/
// API extensions (1, 2, 3) are handled in the server code / by Yemot's own
// "* = back" in recordings; menus already go back with *. Every top-level
// extension is listed and reported, so nothing is changed blindly.
export const STAR_KEYS = { 'control_play*': 'go_to_folder', 'playfile_control_play_*_goto': '/' };
export const PLAYBACK_TYPES = new Set(['playfile', 'last_play', 'folder_play_random', 'phone_play_list', 'play_and_return']);

export function iniType(text) {
  const m = /^\s*type\s*=\s*([^\s;]+)/m.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

export function hasStarToMain(text) {
  const t = String(text || '');
  return /^\s*control_play\*\s*=\s*go_to_folder\s*$/m.test(t) && /^\s*playfile_control_play_\*_goto\s*=\s*\/\s*$/m.test(t);
}

export async function applyStarToMainMenu({ base, token, fetchImpl = fetch, log = console } = {}) {
  const get = async (fn, params) => (await fetchImpl(base + '/' + fn + '?' + new URLSearchParams({ token, ...params }), { signal: AbortSignal.timeout(20000) })).json();
  const root = await get('GetIVR2Dir', { path: 'ivr2:/' });
  const dirs = (root?.dirs || []).map(d => String(d.name || d.what || '').replace(/^.*\//, '')).filter(Boolean);
  const report = [];
  for (const name of dirs) {
    const path = 'ivr2:/' + name;
    let text = '';
    try { text = String((await get('GetTextFile', { what: path + '/ext.ini' }))?.contents ?? ''); } catch { /* none */ }
    const type = iniType(text);
    const row = { ext: name, type };
    if (PLAYBACK_TYPES.has(type)) {
      if (hasStarToMain(text)) row.star = 'already';
      else {
        const r = await get('UpdateExtension', { path, ...STAR_KEYS }).catch(e => ({ responseStatus: 'ERR', message: String(e?.message || e) }));
        row.star = r?.responseStatus === 'OK' ? 'set' : 'failed:' + String(r?.message || r?.responseStatus).slice(0, 80);
      }
    } else row.star = type === 'api' ? 'api (server code / Yemot back key)' : 'not playback';
    report.push(row);
  }
  log.info?.('[STAR_KEYS] every extension checked', JSON.stringify(report));
  return report;
}
