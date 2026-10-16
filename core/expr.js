// Expression language used for every numeric value in a CAD document.
//
//   numbers      12, 3.5, 1e-3, with optional unit suffix: 10mm 2cm 1in 0.5m 1ft 30deg 1rad
//   operators    + - * / % ^ (power), unary -, parentheses
//   functions    sin cos tan (degrees), asin acos atan atan2 (return degrees), sqrt abs min max
//                floor ceil round pow log ln exp hypot clamp sign
//   constants    pi, e
//   names        parameter names (letters, digits, _) — resolved from the scope
//   sketch fns   len(l1) dist(p1,p2) x(p1) y(p1) r(c1) angle(l1) — only inside sketch equations
//
// Lengths are millimetres, angles are degrees.

const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, rad: 180 / Math.PI };
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const FUNCS = {
  sin: (a) => Math.sin(a * D2R), cos: (a) => Math.cos(a * D2R), tan: (a) => Math.tan(a * D2R),
  asin: (a) => Math.asin(a) * R2D, acos: (a) => Math.acos(a) * R2D, atan: (a) => Math.atan(a) * R2D,
  atan2: (y, x) => Math.atan2(y, x) * R2D,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil,
  round: (a, d = 0) => { const f = 10 ** d; return Math.round(a * f) / f; },
  pow: Math.pow, log: Math.log10, ln: Math.log, exp: Math.exp, hypot: Math.hypot, sign: Math.sign,
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
};
export const CONSTS = { pi: Math.PI, e: Math.E };
// Functions whose arguments are entity ids (evaluated by the sketch solver).
export const ENTITY_FUNCS = new Set(['len', 'dist', 'x', 'y', 'r', 'angle']);

export class ExprError extends Error {}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`Bad number at "${src.slice(i)}"`);
      let v = parseFloat(m[0]);
      i += m[0].length;
      const u = /^(mm|cm|in|ft|deg|rad|m)(?![A-Za-z0-9_])/.exec(src.slice(i));
      if (u) { v *= UNITS[u[1]]; i += u[0].length; }
      toks.push({ t: 'num', v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new ExprError(`Unexpected character "${c}" in "${src}"`);
  }
  toks.push({ t: 'end' });
  return toks;
}

// Pratt parser → AST nodes: {k:'num',v} {k:'id',v} {k:'neg',a} {k:'bin',op,a,b} {k:'call',f,args}
export function parse(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    if (toks[p].t !== t) throw new ExprError(`Expected "${t}" in "${src}"`);
    return toks[p++];
  };
  const BP = { '+': 10, '-': 10, '*': 20, '/': 20, '%': 20, '^': 30 };
  function prefix() {
    const tk = toks[p++];
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === '-') return { k: 'neg', a: expr(25) };
    if (tk.t === '+') return expr(25);
    if (tk.t === '(') { const e = expr(0); eat(')'); return e; }
    if (tk.t === 'id') {
      if (peek().t === '(') {
        p++;
        const args = [];
        if (peek().t !== ')') {
          args.push(expr(0));
          while (peek().t === ',') { p++; args.push(expr(0)); }
        }
        eat(')');
        return { k: 'call', f: tk.v, args };
      }
      return { k: 'id', v: tk.v };
    }
    throw new ExprError(`Unexpected "${tk.t === 'end' ? 'end of input' : tk.v ?? tk.t}" in "${src}"`);
  }
  function expr(minBp) {
    let left = prefix();
    for (;;) {
      const op = peek().t;
      const bp = BP[op];
      if (bp === undefined || bp <= minBp) break;
      p++;
      const right = expr(op === '^' ? bp - 1 : bp); // ^ is right-associative
      left = { k: 'bin', op, a: left, b: right };
    }
    return left;
  }
  const ast = expr(0);
  if (peek().t !== 'end') throw new ExprError(`Unexpected trailing input in "${src}"`);
  return ast;
}

// Names referenced by an AST (excluding function names and entity-function arguments).
export function names(ast, out = new Set()) {
  switch (ast.k) {
    case 'id': if (!(ast.v in CONSTS)) out.add(ast.v); break;
    case 'neg': names(ast.a, out); break;
    case 'bin': names(ast.a, out); names(ast.b, out); break;
    case 'call': if (!ENTITY_FUNCS.has(ast.f)) ast.args.forEach((a) => names(a, out)); break;
  }
  return out;
}

// Entity ids referenced through sketch functions such as len(l1).
export function entityRefs(ast, out = new Set()) {
  if (ast.k === 'call') {
    if (ENTITY_FUNCS.has(ast.f)) ast.args.forEach((a) => a.k === 'id' && out.add(a.v));
    else ast.args.forEach((a) => entityRefs(a, out));
  } else if (ast.k === 'neg') entityRefs(ast.a, out);
  else if (ast.k === 'bin') { entityRefs(ast.a, out); entityRefs(ast.b, out); }
  return out;
}

// scope: (name) => number | undefined ; entityFn: (fname, ids[]) => number
export function evalAst(ast, scope, entityFn) {
  switch (ast.k) {
    case 'num': return ast.v;
    case 'id': {
      if (ast.v in CONSTS) return CONSTS[ast.v];
      const v = scope(ast.v);
      if (v === undefined || Number.isNaN(v)) throw new ExprError(`Unknown name "${ast.v}"`);
      return v;
    }
    case 'neg': return -evalAst(ast.a, scope, entityFn);
    case 'bin': {
      const a = evalAst(ast.a, scope, entityFn), b = evalAst(ast.b, scope, entityFn);
      switch (ast.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return a / b; case '%': return a % b; case '^': return a ** b;
      }
      break;
    }
    case 'call': {
      if (ENTITY_FUNCS.has(ast.f)) {
        if (!entityFn) throw new ExprError(`${ast.f}() is only available in sketch equations`);
        return entityFn(ast.f, ast.args.map((a) => {
          if (a.k !== 'id') throw new ExprError(`${ast.f}() takes entity ids`);
          return a.v;
        }));
      }
      const f = FUNCS[ast.f];
      if (!f) throw new ExprError(`Unknown function "${ast.f}"`);
      return f(...ast.args.map((a) => evalAst(a, scope, entityFn)));
    }
  }
  throw new ExprError('Bad expression');
}

const cache = new Map();
export function parseCached(src) {
  let a = cache.get(src);
  if (!a) { a = parse(src); if (cache.size > 5000) cache.clear(); cache.set(src, a); }
  return a;
}

// Evaluate a value that may be a number, numeric string or expression string.
export function evaluate(value, scope = () => undefined, entityFn) {
  if (typeof value === 'number') return value;
  if (value === undefined || value === null || value === '') throw new ExprError('Missing value');
  return evalAst(parseCached(String(value)), typeof scope === 'function' ? scope : (n) => scope[n], entityFn);
}

// Resolve a parameter table {name: expr} into {name: number}. Throws on cycles / errors,
// but collects per-parameter errors so one bad parameter doesn't break the rest.
export function evaluateParams(params = {}) {
  const values = {}, errors = {}, state = {};
  const visit = (name, stack) => {
    if (state[name] === 2) return values[name];
    if (state[name] === 1) throw new ExprError(`Circular parameter reference: ${[...stack, name].join(' → ')}`);
    if (!(name in params)) return undefined;
    state[name] = 1;
    try {
      const ast = parseCached(String(params[name]));
      values[name] = evalAst(ast, (n) => visit(n, [...stack, name]));
    } catch (e) {
      errors[name] = e.message;
      values[name] = NaN;
    }
    state[name] = 2;
    return values[name];
  };
  for (const n of Object.keys(params)) {
    if (!isValidName(n)) { errors[n] = `"${n}" is not a valid parameter name (reserved or malformed)`; values[n] = NaN; state[n] = 2; continue; }
    try { visit(n, []); } catch (e) { errors[n] = e.message; values[n] = NaN; state[n] = 2; }
  }
  return { values, errors };
}

export function isValidName(n) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !(n in CONSTS) && !(n in FUNCS) && !(n in UNITS);
}
