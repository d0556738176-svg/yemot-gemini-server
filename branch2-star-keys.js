// Owner's rule (12.11, replaces 06.11): in every playback extension the star
// key is Yemot's own star menu again (playlist settings, as it was before),
// and 0 returns to the main menu:
//   control_play0=go_to_folder + playfile_control_play_0_goto=/
// Any older "* = main menu" lines are removed so Yemot's default star works.
// API extensions (1, 2, 3) are handled in the server code; menus are left as is.
// Every top-level extension is listed and reported, so nothing is changed blindly.
export const MAIN_MENU_KEY = '0';
export const MAIN_KEYS = { ['control_play' + MAIN_MENU_KEY]: 'go_to_folder', ['playfile_control_play_' + MAIN_MENU_KEY + '_goto']: '/' };
export const PLAYBACK_TYPES = new Set(['playfile', 'last_play', 'folder_play_random', 'phone_play_list', 'play_and_return']);

export function iniType(text) {
  const m = /^\s*type\s*=\s*([^\s;]+)/m.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

const STAR_LINE = /^\s*(control_play\*|playfile_control_play_\*_goto)\s*=/;
const KEY_LINE = new RegExp('^\\s*(control_play' + MAIN_MENU_KEY + '|playfile_control_play_' + MAIN_MENU_KEY + '_goto)\\s*=');

// The ini with the star lines removed and 0 = main menu set (other lines kept).
export function withMainMenuKey(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '' && !STAR_LINE.test(l) && !KEY_LINE.test(l));
  return [...lines, ...Object.entries(MAIN_KEYS).map(([k, v]) => k + '=' + v)].join('\n') + '\n';
}

export async function applyMainMenuKey({ base, token, fetchImpl = fetch, log = console } = {}) {
  const get = async (fn, params) => (await fetchImpl(base + '/' + fn + '?' + new URLSearchParams({ token, ...params }), { signal: AbortSignal.timeout(20000) })).json();
  const post = async (fn, params) => (await fetchImpl(base + '/' + fn, { method: 'POST', body: new URLSearchParams({ token, ...params }), signal: AbortSignal.timeout(20000) })).json();
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
      const want = withMainMenuKey(text);
      if (want.trim() === text.replace(/\r/g, '').trim()) row.keys = 'already';
      else {
        const r = await post('UploadTextFile', { what: path + '/ext.ini', contents: want }).catch(e => ({ responseStatus: 'ERR', message: String(e?.message || e) }));
        row.keys = r?.responseStatus === 'OK' ? 'set (* = star menu, 0 = main menu)' : 'failed:' + String(r?.message || r?.responseStatus).slice(0, 80);
      }
    } else row.keys = type === 'api' ? 'api (server code)' : 'not playback';
    report.push(row);
  }
  log.info?.('[PLAY_KEYS] every extension checked', JSON.stringify(report));
  return report;
}
// Old name kept for callers.
export const applyStarToMainMenu = applyMainMenuKey;
