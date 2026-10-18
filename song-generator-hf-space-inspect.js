// One-off read-only schema inspection; this does not generate audio or use GPU quota.\n// Include all endpoint names and exact positional indices.
const base = String(process.env.HF_MUSIC_SPACE_URL || 'https://ace-step-ace-step-v1-5.hf.space').replace(/\/$/, '');
const response = await fetch(base + '/gradio_api/info', { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error('Hugging Face Space info HTTP ' + response.status);
const info = await response.json();
const endpoints = info?.named_endpoints;
if (!endpoints || typeof endpoints !== 'object') throw new Error('No named Gradio endpoints were returned');
const matches = Object.entries(endpoints).filter(([, schema]) => {
  const names = (schema?.parameters || []).map(p => String(p.parameter_name || p.name || p.label || '').toLowerCase());
  return names.some(n => n.includes('caption')) && names.some(n => n.includes('lyrics'));
});
console.log(JSON.stringify({
  endpointCount: Object.keys(endpoints).length,
  endpointNames: Object.keys(endpoints),
  generationEndpoint: endpoints['/generation_wrapper'] ? {
    parameterCount: (endpoints['/generation_wrapper'].parameters || []).length,
    parameters: (endpoints['/generation_wrapper'].parameters || []).map((p, index) => ({
      index,
      name: String(p.parameter_name || p.name || p.label || ''),
      type: p.type?.type || p.type || p.parameter_type || null,
      defaultType: (p.parameter_default ?? p.default) === null ? 'null' : Array.isArray(p.parameter_default ?? p.default) ? 'array' : typeof (p.parameter_default ?? p.default),
      defaultPreview: (() => { const d = Object.prototype.hasOwnProperty.call(p, 'parameter_default') ? p.parameter_default : p.default; if (d === undefined) return '[undefined]'; if (d === null) return null; if (Array.isArray(d)) return `[array length=${d.length}]`; if (typeof d === 'string') return d.slice(0, 100); if (typeof d === 'number' || typeof d === 'boolean') return d; return `[${typeof d}]`; })(),
      choicesPreview: Array.isArray(p.options) ? p.options.slice(0, 12).map(o => typeof o === 'string' ? o : (o?.value ?? o?.label ?? '[option]')) : undefined
    }))
  } : null,
  candidates: matches.map(([name, schema]) => ({
    name,
    parameterCount: (schema.parameters || []).length,
    parameters: schema.parameters.map(p => {
      const n = String(p.parameter_name || p.name || p.label || '');
      const d = Object.prototype.hasOwnProperty.call(p, 'parameter_default') ? p.parameter_default : p.default;
      return {
        name: n,
        type: p.type || p.parameter_type || null,
        hasDefault: Boolean(p.parameter_has_default) || Object.prototype.hasOwnProperty.call(p, 'parameter_default') || Object.prototype.hasOwnProperty.call(p, 'default'),
        defaultType: d === null ? 'null' : Array.isArray(d) ? 'array' : typeof d
      };
    })
  }))
}, null, 2));
