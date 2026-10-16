/**
 * A deliberately small, non-eval arithmetic parser. It accepts numbers,
 * parentheses, + - * / % ^, pi/e and a few numeric functions. Anything else
 * returns null so the caller can ask the AI instead; no input ever becomes
 * JavaScript, shell, SQL, or a dynamic import.
 */

const MAX_INPUT_LENGTH = 500;
const FUNCTIONS = Object.freeze({
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log10,
  ln: Math.log,
});

function tokenize(input) {
  const text = String(input || '').trim();
  if (!text || text.length > MAX_INPUT_LENGTH) return null;
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const space = rest.match(/^\s+/);
    if (space) {
      i += space[0].length;
      continue;
    }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const word = rest.match(/^[a-z]+/i);
    if (word) {
      tokens.push({ type: 'word', value: word[0].toLowerCase() });
      i += word[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(rest[0])) {
      tokens.push({ type: rest[0], value: rest[0] });
      i += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(type = null) {
    const token = this.tokens[this.index];
    return token && (!type || token.type === type) ? token : null;
  }

  take(type = null) {
    const token = this.peek(type);
    if (!token) throw new Error('invalid expression');
    this.index += 1;
    return token;
  }

  expression() {
    let value = this.term();
    while (this.peek('+') || this.peek('-')) {
      const operator = this.take().type;
      const right = this.term();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  term() {
    let value = this.power();
    while (this.peek('*') || this.peek('/') || this.peek('%')) {
      const operator = this.take().type;
      const right = this.power();
      if ((operator === '/' || operator === '%') && right === 0) throw new Error('division by zero');
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  }

  power() {
    let value = this.unary();
    if (this.peek('^')) {
      this.take('^');
      value **= this.power(); // right-associative: 2^3^2 = 512
    }
    return value;
  }

  unary() {
    if (this.peek('+')) {
      this.take('+');
      return this.unary();
    }
    if (this.peek('-')) {
      this.take('-');
      return -this.unary();
    }
    return this.primary();
  }

  primary() {
    if (this.peek('number')) return this.take('number').value;
    if (this.peek('(')) {
      this.take('(');
      const value = this.expression();
      this.take(')');
      return value;
    }
    if (this.peek('word')) {
      const name = this.take('word').value;
      if (name === 'pi') return Math.PI;
      if (name === 'e') return Math.E;
      const fn = FUNCTIONS[name];
      if (!fn || !this.peek('(')) throw new Error('unsupported symbol');
      this.take('(');
      const value = this.expression();
      this.take(')');
      return fn(value);
    }
    throw new Error('invalid expression');
  }
}

function displayNumber(value) {
  if (!Number.isFinite(value)) throw new Error('result is not finite');
  if (Object.is(value, -0)) return '0';
  // Avoid the long binary floating-point tail for ordinary phone calculations.
  const rounded = Number(value.toPrecision(14));
  return String(rounded);
}

/**
 * @returns {{value:number, text:string}|null} null means use the AI fallback.
 */
export function calculateLocally(input) {
  const tokens = tokenize(input);
  if (!tokens?.length) return null;
  try {
    const parser = new Parser(tokens);
    const value = parser.expression();
    if (parser.index !== tokens.length) return null;
    return { value, text: displayNumber(value) };
  } catch {
    return null;
  }
}

export function splitCalcRequest(text) {
  const raw = String(text || '').trim();
  const process = /(?:^|\s)--process\s*$/i.test(raw);
  const equation = raw.replace(/(?:^|\s)--process\s*$/i, '').trim();
  return { equation, process };
}

export default { calculateLocally, splitCalcRequest };
