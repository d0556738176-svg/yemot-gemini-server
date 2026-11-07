// Free Microsoft Edge "Read aloud" speech (neural voices, incl. he-IL and en-US).
// Port of the Python edge-tts 7.3.1 protocol, including its Sec-MS-GEC v2 token.
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN;
const HEADERS = {
  Pragma: 'no-cache', 'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br, zstd', 'Accept-Language': 'en-US,en;q=0.9',
};

// ---------- Sec-MS-GEC v2 (exact port, BigInt arithmetic like Python ints) ----------
const B = BigInt, M = 0xFFFFFFFFn;
const INIT = [0x6A09E667n, 0xBB67AE85n, 0x3C6EF372n, 0xA54FF53An, 0x510E527Fn, 0x9B05688Cn, 0x1F83D9ABn, 0x5BE0CD19n];
const STATE = [0xFD9FBEA2n, 0x91243CE7n, 0xBE499094n, 0xCD2E1E0An, 0x6C006F49n, 0x04BD35ABn, 0xFEB0A7E4n, 0x03EFFBD2n];
const SCHED = [0xEB24BF9En, 0x1558691Fn, 0xA0C09EE2n, 0x0CFA32BAn, 0xA622EE8Cn, 0xD1DD9491n, 0xC0DD25A0n, 0xF9E70AB6n, 0xF0C31573n, 0x7058CE4En, 0x7188E606n, 0x00E5AB33n, 0xD258B060n, 0x72766564n];
const K = [0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2].map(B);
const ADJ = 0xC9DC06A7n;
const KB = [...K.slice(0, 14), ADJ, ...K.slice(15)];
const SIG0_ADJ = 0x059C0B80n, SIG1_ADJ = 0x000B92C0n;
const CS64 = [[0xE82E91B1n, 0xB32700D0n], [0x44DE24C6n, 0x88DFF51Dn], [0x3BEB65BCn, 0x29514038n], [0xC89C5933n, 0xB328CBDFn], [0x8D1EC211n, 0xD405B4D5n], [0x314EF5D5n, 0x26E55F3Cn], [0xE92491B1n, 0x607801C6n], [0xF0A5B9D5n, 0x82B2C1FBn], [0x06064CF3n, 0xFA51A3DAn], [0xDA79FA60n, 0x207CC464n], [0xBED20560n, 0x3C3C74F3n], [0x89F9C9F8n, 0xD2D14B61n], [0x35FA38C6n, 0xBB04A2C1n], [0xCB49E3C6n, 0xC5626167n]];
const CS64_FACTOR = 0x82893933n, CS64_ADJ0 = 0xF2F90B1An, CS64_ADJ1 = 0x0B1A0000n;

const rol16 = v => { v &= M; return ((v << 16n) | (v >> 16n)) & M; };
const sigma0 = v => ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & M;
const sigma1 = v => ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & M;
const R = 0x100000001n;

function rounds(state, words, first = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? KB : K;
  for (let i = first; i < 64; i++) {
    const re = e * R, ra = a * R;
    const t1 = h + ((re >> 6n) ^ (re >> 11n) ^ (re >> 25n)) + (g ^ (e & (f ^ g))) + k[i] + words[i];
    const t2 = ((ra >> 2n) ^ (ra >> 13n) ^ (ra >> 22n)) + ((a & b) | (c & (a | b)));
    [a, b, c, d, e, f, g, h] = [(t1 + t2) & M, a, b, c, (d + t1) & M, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}

function expand(words, first = 16) {
  for (let i = first; i < 64; i++) {
    const x = words[i - 2], y = words[i - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    words.push((s1 + words[i - 7] + s0 + words[i - 16]) & M);
  }
}

const be = bytes => bytes.reduce((acc, x) => (acc << 8n) | B(x), 0n);

function shaInit(data) {
  const w = Array(14).fill(0n);
  w.push(be(data.subarray(0, 3)), be(data.subarray(3, 7)));
  for (let i = 16; i < 30; i++) {
    let v = SCHED[i - 16];
    if (i - 2 >= 14) v += i === 16 ? (sigma1(w[i - 2]) ^ SIG1_ADJ) : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? (sigma0(w[i - 15]) ^ SIG0_ADJ) : sigma0(w[i - 15]);
    w.push(v & M);
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + ADJ - K[14]) & M);
  expand(w, 31);
  const work = rounds(STATE, w, 14);
  return INIT.map((x, i) => (x + work[i]) & M);
}

function shaDigest(data) {
  const length = 57 + data.length;
  const padLen = ((55 - length) % 64 + 64) % 64;
  const lenBuf = Buffer.alloc(8); lenBuf.writeBigUInt64BE(B(length * 8));
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padLen), lenBuf]);
  let state = shaInit(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let j = 0; j < 16; j++) w.push(B(padded.readUInt32BE(off + j * 4)));
    expand(w);
    const work = rounds(state, w);
    state = state.map((x, i) => (x + work[i]) & M);
  }
  const out = Buffer.alloc(32);
  state.forEach((x, i) => out.writeUInt32BE(Number(x), i * 4));
  return out;
}

function wordsLe4Even(data) {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(B(padded.readUInt32LE(i)));
  if (words.length % 2) words.push(0n);
  return words;
}

function cs64(data, digest) {
  let keyA = B(digest.readUInt32LE(0)) | 1n, keyB = B(digest.readUInt32LE(4)) | 1n;
  const factors = [(keyA * CS64_FACTOR) & M, (keyB * CS64_FACTOR) & M];
  const terms = CS64.map(([c], i) => (c * factors[i % 2]) & M);
  const offsets = CS64.map(([, o]) => o);
  wordsLe4Even(Buffer.concat([Buffer.from([0]), data])).forEach((word, i) => {
    let term = word * (i % 2 === 0 ? keyA : keyB);
    let off = rol16(word) * (i % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
    if (i === 0) { term += CS64_ADJ0 * factors[0]; off += CS64_ADJ1; }
    terms.push(term & M); offsets.push(off & M);
  });
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) & M);
    let q = (t * 0x76F50F34n) & M;
    swapAcc += (rol16(q) * 0xC3EFEA97n + q) & M;
    t = rol16((offsets[i + 1] + y) & M);
    q = (t * 0x1881CE3Cn) & M;
    swapLast = (rol16(q) * 0x35BD1EC9n + q) & M;
    swapAcc = (swapAcc + swapLast) & M;
    state = (state * keyA + x) & M;
    state = (rol16(state) * 0xCF98B111n) & M;
    state = (rol16(state) * 0x87085B9Fn) & M;
    state = (rol16(state) * 0x12CEB96Dn) & M;
    state = (rol16(state) * 0x257E1D83n) & M;
    acc += state;
    t = (state * keyB + y) & M;
    t = (rol16(t) * 0xA27416F5n) & M;
    t = (rol16(t) * 0xD38396FFn) & M;
    state = (rol16((rol16(t) * 0x7C932B89n) & M) * 0xBFA49F69n) & M;
    acc = (acc + state) & M;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

let clockSkew = 0;
export function secMsGec(unixSeconds = Date.now() / 1000 + clockSkew) {
  let ticks = Math.floor(unixSeconds) + 11644473600;
  ticks -= ticks % 300;
  const str = Buffer.from(B(ticks) * 10000000n + TRUSTED_CLIENT_TOKEN, 'ascii');
  const digest = shaDigest(str);
  const [w0, w1] = cs64(str, digest);
  const c = Buffer.alloc(8); c.writeUInt32LE(Number(w0), 0); c.writeUInt32LE(Number(w1), 4);
  return c.toString('hex').toUpperCase() + '-' + digest.toString('hex').toUpperCase();
}

// ---------- WebSocket synthesis ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const jsDate = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) /, '$1 $3 $2 $4 ').replace('GMT', 'GMT+0000 (Coordinated Universal Time)');

export function synthesize(text, { voice = 'en-US-AndrewNeural', rate = '+0%', pitch = '+0Hz', timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const connId = randomUUID().replace(/-/g, '');
    const url = `${WSS_URL}&ConnectionId=${connId}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=2-${CHROMIUM_FULL_VERSION}`;
    const ws = new WebSocket(url, { headers: { ...HEADERS, Cookie: 'muid=' + randomBytes(16).toString('hex').toUpperCase() + ';' }, perMessageDeflate: true });
    const chunks = [];
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('edge-tts timeout')); }, timeoutMs);
    const fail = e => { clearTimeout(timer); try { ws.terminate(); } catch {} reject(e); };
    ws.on('unexpected-response', (req, res) => {
      const date = res.headers?.date;
      if (res.statusCode === 403 && date) clockSkew = Date.parse(date) / 1000 - Date.now() / 1000;
      fail(new Error('edge-tts HTTP ' + res.statusCode));
    });
    ws.on('error', fail);
    ws.on('open', () => {
      ws.send(`X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${esc(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const headerLen = data.readUInt16BE(0);
        const header = data.subarray(2, 2 + headerLen).toString();
        if (/Path:audio/.test(header)) { const audio = data.subarray(2 + headerLen); if (audio.length) chunks.push(audio); }
      } else if (/Path:turn\.end/.test(data.toString())) {
        clearTimeout(timer); ws.close();
        if (!chunks.length) return reject(new Error('edge-tts: no audio'));
        resolve(Buffer.concat(chunks));
      }
    });
  });
}
