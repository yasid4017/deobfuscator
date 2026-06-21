// Vercel Serverless Function: /api/deobfuscator
// Heuristic deobfuscator untuk script Lua yang di-obfuscate gaya Prometheus.
// CATATAN: ini deobfuscator heuristik (string decode + rename + beautify),
// bukan emulator VM penuh. Obfuscation berbasis VM bytecode kompleks
// kemungkinan tidak akan ter-resolve 100%.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const code = body && body.code;

    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'field "code" kosong atau tidak valid' });
      return;
    }

    if (code.length > 2_000_000) {
      res.status(400).json({ error: 'kode terlalu besar (max ~2MB)' });
      return;
    }

    const result = deobfuscatePrometheus(code);
    res.status(200).json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
};

function deobfuscatePrometheus(src) {
  let code = src;

  code = decodeStringChar(code);
  code = decodeEscapeSequences(code);
  code = stripWatermarks(code);
  code = renameObfuscatedIdentifiers(code);
  code = beautifyLua(code);

  return code;
}

// 1) ubah panggilan string.char(a, b, c, ...) jadi literal string
function decodeStringChar(code) {
  return code.replace(/string\.char\(([^()]+)\)/g, (m, args) => {
    const parts = args.split(',').map(s => s.trim());
    const nums = parts.map(s => parseInt(s, 10));
    if (nums.some(n => Number.isNaN(n) || n < 0 || n > 255)) return m;
    const str = nums.map(n => String.fromCharCode(n)).join('');
    return luaStringLiteral(str);
  });
}

// 2) decode escape \ddd dan \xXX di dalam string literal
function decodeEscapeSequences(code) {
  return code.replace(/"((?:\\.|[^"\\])*)"/g, (m, body) => {
    if (!/\\(\d{1,3}|x[0-9a-fA-F]{2})/.test(body)) return m;
    let out = '';
    let i = 0;
    while (i < body.length) {
      if (body[i] === '\\') {
        const rest = body.slice(i + 1);
        const dec = rest.match(/^(\d{1,3})/);
        const hex = rest.match(/^x([0-9a-fA-F]{2})/);
        if (dec) {
          out += String.fromCharCode(parseInt(dec[1], 10));
          i += 1 + dec[1].length;
          continue;
        }
        if (hex) {
          out += String.fromCharCode(parseInt(hex[1], 16));
          i += 1 + 1 + hex[1].length;
          continue;
        }
        out += body[i] + (body[i + 1] || '');
        i += 2;
        continue;
      }
      out += body[i];
      i++;
    }
    return luaStringLiteral(out);
  });
}

// 3) buang komentar watermark obfuscator
function stripWatermarks(code) {
  code = code.replace(/--\[\[[\s\S]*?Prometheus[\s\S]*?\]\]/gi, '');
  code = code.replace(/^[ \t]*--.*Prometheus.*$/gim, '');
  return code;
}

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while', 'self'
]);

// 4) rename identifier hasil obfuscation (mis. _0x1a2b, l_1_1) -> v1, v2, ...
function renameObfuscatedIdentifiers(code) {
  const pattern = /\b(_0x[0-9a-fA-F]{3,}|l_[0-9]+_[0-9]+|L_[0-9]+_)\w*\b/g;
  const map = new Map();
  let counter = 1;
  return code.replace(pattern, (m) => {
    if (LUA_KEYWORDS.has(m)) return m;
    if (!map.has(m)) map.set(m, 'v' + counter++);
    return map.get(m);
  });
}

// 5) indentasi ulang supaya bisa dibaca
function beautifyLua(code) {
  const lines = code.split('\n').map(l => l.trim());
  let depth = 0;
  const out = [];

  for (const line of lines) {
    if (line === '') { out.push(''); continue; }

    const isDedent = /^(end\b|else\b|elseif\b|until\b)/.test(line);
    const printDepth = isDedent ? Math.max(0, depth - 1) : depth;

    out.push('    '.repeat(printDepth) + line);

    let scan = line;
    if (/^end\b/.test(scan)) scan = scan.replace(/^end\b/, '');
    if (/^until\b/.test(scan)) scan = scan.replace(/^until\b/, '');

    const opens = (scan.match(/\b(function|then|do|repeat)\b/g) || []).length;
    const closes = (scan.match(/\bend\b/g) || []).length;
    let delta = opens - closes;

    if (line === 'else') delta = 1; // 'else' membuka blok tanpa keyword 'then'

    depth = Math.max(0, printDepth + delta);
  }

  return out.join('\n');
}

function luaStringLiteral(str) {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return '"' + escaped + '"';
}
