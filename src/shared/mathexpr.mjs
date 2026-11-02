// Maths expressions for boards, such as "2 sin(a x)^2 / sqrt(x)", compiled into functions without eval.
const FUNCTIONS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log, log2: Math.log2, log10: Math.log10,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
};
const CONSTANTS = { pi: Math.PI, PI: Math.PI, "π": Math.PI, tau: 2 * Math.PI, e: Math.E, E: Math.E };
const TOKEN = /\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|[A-Za-z_π][\w]*|\*\*|[-+*/^(),])/iy;

function tokenize(source) {
    const tokens = [];
    let at = 0;
    for (let match; at < source.length; at = TOKEN.lastIndex) {
        TOKEN.lastIndex = at;
        if (!(match = TOKEN.exec(source))) break;
        tokens.push(match[1] === "**" ? "^" : match[1]);
    }
    if (source.slice(at).trim()) throw new Error(`cannot read "${source.slice(at).trim().slice(0, 12)}" in "${source}"`);
    return tokens;
}

// Returns f(scope) using the given variable names; throws a readable error for invalid expressions.
export function compile(source, names = []) {
    const text = String(source ?? "");
    const tokens = tokenize(text);
    const known = new Set(names);
    let i = 0;
    const fail = (message) => {
        throw new Error(`${message} in "${text}"`);
    };
    const starts = (token) => token !== undefined && (/^[\d.A-Za-z_π]/.test(token) || token === "(");

    const sum = () => {
        let left = product();
        while (tokens[i] === "+" || tokens[i] === "-") {
            const [op, l, r] = [tokens[i++], left, product()];
            left = op === "+" ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
        }
        return left;
    };
    // Juxtaposition multiplies, as in 2x or 3(x + 1).
    const product = () => {
        let left = unary();
        for (;;) {
            const explicit = tokens[i] === "*" || tokens[i] === "/";
            if (!explicit && !starts(tokens[i])) return left;
            const op = explicit ? tokens[i++] : "*";
            const [l, r] = [left, explicit ? unary() : power()];
            left = op === "/" ? (s) => l(s) / r(s) : (s) => l(s) * r(s);
        }
    };
    const unary = () => {
        if (tokens[i] === "-") {
            i++;
            const v = unary();
            return (s) => -v(s);
        }
        if (tokens[i] === "+") i++;
        return power();
    };
    // Powers bind tighter than a leading minus and group to the right: -x^2 is -(x^2) and 2^3^2 is 2^9.
    const power = () => {
        const base = primary();
        if (tokens[i] !== "^") return base;
        i++;
        const exponent = unary();
        return (s) => Math.pow(base(s), exponent(s));
    };
    const primary = () => {
        const token = tokens[i++];
        if (token === undefined) fail("unexpected end");
        if (token === "(") {
            const inner = sum();
            if (tokens[i++] !== ")") fail('missing ")"');
            return inner;
        }
        if (/^[\d.]/.test(token)) {
            const value = Number(token);
            return () => value;
        }
        if (FUNCTIONS[token] && tokens[i] === "(") {
            i++;
            const args = tokens[i] === ")" ? [] : [sum()];
            while (tokens[i] === ",") {
                i++;
                args.push(sum());
            }
            if (tokens[i++] !== ")") fail(`missing ")" after ${token}(`);
            const fn = FUNCTIONS[token];
            return (s) => fn(...args.map((arg) => arg(s)));
        }
        if (known.has(token)) return (s) => s[token];
        if (token in CONSTANTS) return () => CONSTANTS[token];
        if (/^[A-Za-z_π]/.test(token)) fail(`unknown name "${token}" (use ${[...known].join(", ") || "numbers"}, pi, e or functions such as sin, sqrt, exp, ln)`);
        return fail(`unexpected "${token}"`);
    };

    if (!tokens.length) fail("empty expression");
    const fn = sum();
    if (i < tokens.length) fail(`unexpected "${tokens[i]}"`);
    return fn;
}
