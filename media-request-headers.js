// Keep only public playback context; credentials and cookies are never saved.
export function mediaRequestHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const canonical = { 'user-agent': 'User-Agent', referer: 'Referer', origin: 'Origin' }[name.toLowerCase()];
    if (!canonical || typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 2048) continue;
    if (canonical !== 'User-Agent') {
      try { const u = new URL(value); if (!/^https?:$/.test(u.protocol) || u.username || u.password) continue; } catch { continue; }
    }
    out[canonical] = value;
  }
  return out;
}

export function mediaHeaderArgs(headers) {
  return Object.entries(mediaRequestHeaders(headers)).flatMap(([name, value]) => ['--add-headers', name + ':' + value]);
}
