/**
 * Split INSERT ... VALUES (a), (b), ... into separate statements without
 * allocating an array of all tuple strings at once (memory-friendly for large batches).
 */

/** Scan one `(...)` tuple starting at `start`; respects single-quoted strings (PostgreSQL `''` escape). */
export function readBalancedParenTuple(s: string, start: number): { text: string; endIndex: number } | null {
  if (start >= s.length || s[start] !== '(') {
    return null;
  }
  let depth = 0;
  let i = start;
  let inQuote = false;
  while (i < s.length) {
    const c = s[i];
    if (inQuote) {
      if (c === "'" && i + 1 < s.length && s[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (c === "'") {
        inQuote = false;
      }
      i++;
      continue;
    }
    if (c === "'") {
      inQuote = true;
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        return { text: s.slice(start, i + 1), endIndex: i + 1 };
      }
    }
    i++;
  }
  return null;
}

function* iterInsertTuples(afterValues: string): Generator<string> {
  let i = 0;
  while (i < afterValues.length && /\s/.test(afterValues[i])) {
    i++;
  }
  while (i < afterValues.length) {
    const t = readBalancedParenTuple(afterValues, i);
    if (!t) {
      return;
    }
    yield t.text;
    i = t.endIndex;
    while (i < afterValues.length && /\s/.test(afterValues[i])) {
      i++;
    }
    if (i < afterValues.length && afterValues[i] === ',') {
      i++;
      continue;
    }
    break;
  }
}

function parseValuesRest(afterValues: string): { tupleCount: number; rest: string } | null {
  let i = 0;
  while (i < afterValues.length && /\s/.test(afterValues[i])) {
    i++;
  }
  if (i >= afterValues.length || afterValues[i] !== '(') {
    return null;
  }
  let count = 0;
  while (i < afterValues.length) {
    const t = readBalancedParenTuple(afterValues, i);
    if (!t) {
      return null;
    }
    count++;
    i = t.endIndex;
    while (i < afterValues.length && /\s/.test(afterValues[i])) {
      i++;
    }
    if (i < afterValues.length && afterValues[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return { tupleCount: count, rest: afterValues.slice(i) };
}

/**
 * Yield executable SQL fragments: either one non-expanded statement, or one INSERT per VALUES tuple.
 */
export function* iterExpandInsertStatements(statement: string): Generator<string> {
  const trimmed = statement.trim();
  if (!trimmed.length) {
    return;
  }
  const withoutSemi = trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (!/^INSERT\s/i.test(withoutSemi) || !/\bVALUES\b/i.test(withoutSemi)) {
    yield trimmed;
    return;
  }
  const valuesMatch = /\bVALUES\b/i.exec(withoutSemi);
  if (!valuesMatch) {
    yield trimmed;
    return;
  }
  const valuesIdx = valuesMatch.index!;
  const before = withoutSemi.slice(0, valuesIdx).trimEnd();
  const afterValues = withoutSemi.slice(valuesIdx + valuesMatch[0].length).trimStart();

  const parsed = parseValuesRest(afterValues);
  if (!parsed || parsed.tupleCount <= 1) {
    yield trimmed;
    return;
  }

  const restTrim = parsed.rest.trimStart();
  const restClean = restTrim.replace(/;+\s*$/, '').trim();
  if (restClean.length > 0) {
    const ru = restClean.toUpperCase();
    if (!ru.startsWith('ON CONFLICT') && !ru.startsWith('RETURNING')) {
      yield trimmed;
      return;
    }
  }
  const suffixPart = restClean.length > 0 ? ` ${restClean}` : '';

  for (const t of iterInsertTuples(afterValues)) {
    yield `${before} VALUES ${t}${suffixPart};`;
  }
}
