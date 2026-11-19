// Additional audio library for completed website downloads. Existing /7 stays independent.
export const EXT5_INDEX = 'ivr2:/2/youtubeaudio/ext5_index.json';
let queue = Promise.resolve();
export function publishToExt5(id, file, title, io) {
  const task = queue.then(async () => {
    const index = await io.readJson(EXT5_INDEX);
    if (index?.items?.[id]) return index.items[id];
    const listing = await io.list();
    if (listing?.responseStatus !== 'OK' || !Array.isArray(listing.files)) throw new Error('Cannot safely list extension 5');
    const numbers = listing.files.map(f => String(f.name || f.fileName || '').match(/^(\d+)\.wav$/i)).filter(Boolean).map(m => Number(m[1]));
    const next = Math.max(0, Number(index?.next) || 0, ...numbers.map(n => n + 1));
    if (!Number.isSafeInteger(next) || next > 999) throw new Error('Extension 5 library full');
    const number = String(next).padStart(3, '0');
    const items = index?.items || {};
    await io.writeJson(EXT5_INDEX, {version: 1, next: next + 1, items});
    await io.upload(file, 'ivr2:/5/' + number + '.wav');
    const entry = {file: number, title: String(title || '').slice(0,200), at: new Date().toISOString()};
    await io.writeJson(EXT5_INDEX, {version: 1, next: next + 1, items: {...items, [id]: entry}});
    io.log?.info?.('[EXT5] website audio added', {videoId: id, file: number});
    return entry;
  });
  queue = task.catch(() => {});
  return task;
}
