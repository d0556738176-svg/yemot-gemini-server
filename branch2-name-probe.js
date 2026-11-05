// One-time: what file name does Yemot send when a Hebrew-named file is
// downloaded (Content-Disposition), to fix names that arrive as "_ _ _".
const TAG = '[BRANCH2_NAME_PROBE]';
export async function runNameProbe() {
  const p = (await import('./youtube-authorized-playback.js'))._pipeline;
  const MARK = 'ivr2:/2/selftest/name_probe_v1.json';
  if (await p.readCacheJson(MARK).catch(() => null)) return;
  const out = [];
  for (const what of ['ivr2:/אודיו/מוטי_שטיינמץ_הנשמה_בקרבי_Motty_Steinmetz_Haneshama_Bekirbi.flac', 'ivr2:/אודיו/SHWEKEY_Your_Time.m4a']) {
    for (const api of ['DownloadFile']) {
      const u = new URL(p.YEMOT_API_BASE + '/' + api); u.searchParams.set('token', p.yemotApiKey()); u.searchParams.set('path', what);
      const ac = new AbortController();
      const r = await fetch(u, { signal: ac.signal }).catch(e => ({ status: 0, headers: new Map(), e }));
      const h = {}; try { for (const [k, v] of r.headers) if (/disposition|type|length/i.test(k)) h[k] = v; } catch {}
      ac.abort();
      out.push({ what: what.slice(-40), status: r.status, headers: h });
    }
  }
  console.info(TAG, JSON.stringify(out));
  await p.writeCacheJson(MARK, { at: new Date().toISOString(), out }).catch(() => {});
}
