'use strict';

/*
 * Router safety tests — M4 (bad rule must not throw / must not block
 * siblings) and H1 (derived target name length cap).
 * Plain Node, no framework. Run: node test/router-safety.test.js
 * Exits non-zero if any assertion fails.
 */

const path = require('path');
const { createRouter } = require(path.join(__dirname, '..', 'src', 'main', 'router'));
const { ROLES } = require(path.join(__dirname, '..', 'src', 'common', 'line-types'));

let failures = 0;

function ok(cond, name) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    failures++;
    console.log('FAIL: ' + name);
  }
}

// ---------------------------------------------------------------------------
// Invalid pattern does not throw; siblings still work.
// ---------------------------------------------------------------------------

// Bad rule alone: createRouter must not throw, and routing falls through to
// the FEED default since the only rule failed to compile.
{
  let threw = false;
  let router;
  try {
    router = createRouter([{ pattern: '(unbalanced', target: { role: ROLES.FEED } }]);
  } catch (err) {
    threw = true;
  }
  ok(!threw, 'invalid pattern: createRouter does not throw');
  const res = router.route('anything at all');
  ok(res.role === ROLES.FEED, 'invalid pattern (alone): falls through to FEED');
  ok(res.match === null, 'invalid pattern (alone): match is null');
}

// Bad rule first, good rule second: the good rule still matches.
{
  const rules = [
    { pattern: '(unbalanced', target: { role: ROLES.FEED } },
    {
      pattern: '^\\[Public\\]\\s+(\\w+)',
      target: { role: ROLES.CHANNEL, name: 'Public' },
      notify: null,
    },
  ];
  let threw = false;
  let router;
  try {
    router = createRouter(rules);
  } catch (err) {
    threw = true;
  }
  ok(!threw, 'bad rule + good rule: createRouter does not throw');
  const hit = router.route('[Public] Alecto says hello');
  ok(hit.role === ROLES.CHANNEL, 'bad rule + good rule: sibling rule still matches (role)');
  ok(hit.target && hit.target.name === 'Public', 'bad rule + good rule: sibling rule still matches (name)');
}

// ---------------------------------------------------------------------------
// onWarning
// ---------------------------------------------------------------------------

// onWarning is called exactly once with a message mentioning the bad rule's
// index, when one bad rule is present.
{
  const warnings = [];
  const rules = [
    { pattern: '^ok$', target: { role: ROLES.FEED } },
    { pattern: '(unbalanced', target: { role: ROLES.FEED } },
  ];
  createRouter(rules, { onWarning: (msg) => warnings.push(msg) });
  ok(warnings.length === 1, 'onWarning: called exactly once for one bad rule');
  ok(warnings.length === 1 && warnings[0].includes('1'), 'onWarning: message mentions the bad rule index (1)');
}

// onWarning is not required: omitting it from options must not throw.
{
  let threw = false;
  try {
    createRouter([{ pattern: '(unbalanced', target: { role: ROLES.FEED } }]);
    createRouter([{ pattern: '(unbalanced', target: { role: ROLES.FEED } }], {});
  } catch (err) {
    threw = true;
  }
  ok(!threw, 'onWarning: omitting it from options does not throw');
}

// setRules() called later with a new bad-rule array also triggers onWarning.
{
  const warnings = [];
  const router = createRouter([], { onWarning: (msg) => warnings.push(msg) });
  router.setRules([{ pattern: '[unclosed', target: { role: ROLES.FEED } }]);
  ok(warnings.length === 1, 'onWarning: setRules with a new bad rule triggers onWarning again');
}

// ---------------------------------------------------------------------------
// H1: derived name length cap
// ---------------------------------------------------------------------------

// nameFrom capturing a string longer than 200 chars is capped to 200.
{
  const longSender = 'X'.repeat(500);
  const rules = [
    {
      pattern: '^PAGE (?<sender>.+)$',
      target: { role: ROLES.PAGE, nameFrom: 'sender' },
      notify: null,
    },
  ];
  const router = createRouter(rules);
  const res = router.route('PAGE ' + longSender);
  ok(res.role === ROLES.PAGE, 'name cap: long sender line still routes to PAGE');
  ok(!!res.target && res.target.name.length === 200, 'name cap: target name is capped to 200 chars');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log(failures + ' TEST(S) FAILED');
  process.exit(1);
}
