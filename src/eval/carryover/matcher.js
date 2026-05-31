// Deep partial-match between an expected shape and actual tool-call params.
// Returns { passed, mismatches: [{ path, expected, actual, reason }] }.
// Supports 6 tagged operators: $present, $absent, $regex, $in, $contains, $absent_or_empty.
// Keys not in expected are ignored. Primitives match by ===. Objects recurse.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isTaggedMatcher(v) {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  return keys[0].startsWith('$');
}

function matchTagged(tag, expectedValue, actual, path) {
  switch (tag) {
    case '$present':
      if (actual !== undefined && actual !== null) return [];
      return [{ path, expected: '<present>', actual, reason: 'expected present' }];
    case '$absent':
      if (actual === undefined || actual === null) return [];
      return [{ path, expected: '<absent>', actual, reason: 'expected absent' }];
    case '$regex': {
      const re = new RegExp(expectedValue);
      if (typeof actual === 'string' && re.test(actual)) return [];
      return [{ path, expected: `/${expectedValue}/`, actual, reason: 'regex did not match' }];
    }
    case '$in':
      if (Array.isArray(expectedValue) && expectedValue.includes(actual)) return [];
      return [{ path, expected: `one of ${JSON.stringify(expectedValue)}`, actual, reason: 'not in allowed set' }];
    case '$contains':
      if (Array.isArray(actual) && actual.includes(expectedValue)) return [];
      return [{ path, expected: `array containing ${JSON.stringify(expectedValue)}`, actual, reason: 'array did not contain value' }];
    case '$absent_or_empty':
      if (actual === undefined || actual === null) return [];
      if (Array.isArray(actual) && actual.length === 0) return [];
      return [{ path, expected: '<absent or empty>', actual, reason: 'expected absent or empty array' }];
    default:
      return [{ path, expected: tag, actual, reason: `unknown matcher ${tag}` }];
  }
}

function deepMatch(expected, actual, path) {
  if (isTaggedMatcher(expected)) {
    const tag = Object.keys(expected)[0];
    return matchTagged(tag, expected[tag], actual, path);
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return [{ path, expected, actual, reason: 'expected object, got non-object' }];
    }
    const mismatches = [];
    for (const key of Object.keys(expected)) {
      const childPath = path ? `${path}.${key}` : key;
      mismatches.push(...deepMatch(expected[key], actual?.[key], childPath));
    }
    return mismatches;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [{ path, expected, actual, reason: 'expected array, got non-array' }];
    }
    if (expected.length !== actual.length) {
      return [{ path, expected: `length ${expected.length}`, actual: `length ${actual.length}`, reason: 'array length differs' }];
    }
    const mismatches = [];
    for (let i = 0; i < expected.length; i++) {
      mismatches.push(...deepMatch(expected[i], actual[i], `${path}[${i}]`));
    }
    return mismatches;
  }

  if (expected === actual) return [];
  return [{ path, expected, actual, reason: 'value mismatch' }];
}

function match(expected, actual) {
  const mismatches = deepMatch(expected, actual, '');
  return { passed: mismatches.length === 0, mismatches };
}

module.exports = { match };
