// 25.11: models in groups, one group after another (extensions 1 and 3).
// Group i+1 starts when every member of group i has failed, or once group i
// had its fair time (patience[i]); an empty group passes straight on. Nothing
// new starts after the answer arrived (isDone).
export function createTierGate(patience = [], { isDone = () => false, setTimer = setTimeout } = {}) {
  const n = Math.max(patience.length, 1);
  const tiers = Array.from({ length: n }, () => { const t = { members: 0, failed: 0, open: false }; t.p = new Promise(r => { t.resolve = r; }); return t; });
  const open = i => {
    if (i >= n) return; const t = tiers[i]; if (t.open) return;
    t.open = true; t.resolve();
    if (isDone()) return;
    if (t.members === 0 || t.failed >= t.members) open(i + 1);
    else if (i < n - 1 && Number(patience[i]) > 0) { const tm = setTimer(() => open(i + 1), Number(patience[i])); tm?.unref?.(); }
  };
  return {
    add: i => { tiers[i].members++; },
    fail: i => { const t = tiers[i]; t.failed++; if (t.open && t.failed >= t.members) open(i + 1); },
    start: () => open(0),
    ready: i => tiers[i].p,
    isOpen: i => tiers[i].open
  };
}
