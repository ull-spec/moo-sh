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
// combineFrom: group-conversation targets built from multiple capture groups
// (added for Liberation's group-page tabs — see router.js's deriveCombinedName)
// ---------------------------------------------------------------------------

// A single combineFrom group with an Oxford-comma 3-name list is split,
// sorted case-insensitively, and joined.
{
  const rules = [
    {
      pattern: '^Long distance to (?<partners>[^:]+):',
      target: { role: ROLES.PAGE, combineFrom: ['partners'] },
      notify: null,
    },
  ];
  const router = createRouter(rules);
  const res = router.route('Long distance to Zed, Amanda, and Carol: hi all');
  ok(res.role === ROLES.PAGE, 'combineFrom: routes to PAGE');
  ok(
    !!res.target && res.target.name === 'Amanda, Carol, Zed',
    'combineFrom: Oxford-comma list split and sorted case-insensitively (got: ' +
      (res.target && res.target.name) +
      ')'
  );
}

// A bare two-name "X and Y" list (no comma) is also split correctly.
{
  const rules = [
    {
      pattern: '^Long distance to (?<partners>[^:]+):',
      target: { role: ROLES.PAGE, combineFrom: ['partners'] },
      notify: null,
    },
  ];
  const router = createRouter(rules);
  const res = router.route('Long distance to Carol and Amanda: hi');
  ok(
    !!res.target && res.target.name === 'Amanda, Carol',
    'combineFrom: "X and Y" (no comma) split correctly (got: ' + (res.target && res.target.name) + ')'
  );
}

// Two combineFrom groups (recipients list + sender) merge into ONE stable
// key, and it's the SAME key regardless of which participant is speaking —
// this is the actual Liberation group-page bug fix.
{
  const rules = [
    {
      pattern: '^\\(To: (?<partners>[^)]+)\\) (?<sender>[^ (]+) pages: ',
      target: { role: ROLES.PAGE, combineFrom: ['partners', 'sender'] },
      notify: 'page',
    },
  ];
  const router = createRouter(rules);
  const fromDave = router.route('(To: Carol and Amanda) Dave pages: joinable?');
  const fromCarol = router.route('(To: Dave and Amanda) Carol pages: sure');
  ok(
    !!fromDave.target && fromDave.target.name === 'Amanda, Carol, Dave',
    'combineFrom: partners+sender merged and sorted (got: ' + (fromDave.target && fromDave.target.name) + ')'
  );
  ok(
    !!fromDave.target && !!fromCarol.target && fromDave.target.key === fromCarol.target.key,
    'combineFrom: same group conversation keys identically no matter who is speaking'
  );
}

// Duplicate names across combined groups (e.g. same person appearing in both
// captures) are deduped case-insensitively, keeping first-seen casing.
{
  const rules = [
    {
      pattern: '^\\(To: (?<partners>[^)]+)\\) (?<sender>[^ (]+) pages: ',
      target: { role: ROLES.PAGE, combineFrom: ['partners', 'sender'] },
      notify: 'page',
    },
  ];
  const router = createRouter(rules);
  const res = router.route('(To: Amanda, amanda) Dave pages: hi');
  ok(
    !!res.target && res.target.name === 'Amanda, Dave',
    'combineFrom: case-insensitive dedupe keeps first-seen casing (got: ' + (res.target && res.target.name) + ')'
  );
}

// The MAX_NAME_LEN cap (H1, same as nameFrom) still applies to a combined name.
{
  const rules = [
    {
      pattern: '^Long distance to (?<partners>[^:]+):',
      target: { role: ROLES.PAGE, combineFrom: ['partners'] },
      notify: null,
    },
  ];
  const router = createRouter(rules);
  const manyNames = Array.from({ length: 40 }, (_, i) => 'Name' + i).join(', ');
  const res = router.route('Long distance to ' + manyNames + ': hi');
  ok(!!res.target && res.target.name.length === 200, 'combineFrom: combined name is capped to 200 chars');
}

// A combineFrom group that fails to capture anything falls back to null,
// same as nameFrom's missing-group behavior — never throws.
{
  const rules = [
    {
      pattern: '^solo line$',
      target: { role: ROLES.PAGE, combineFrom: ['nope'] },
      notify: null,
    },
  ];
  const router = createRouter(rules);
  let threw = false;
  let res;
  try {
    res = router.route('solo line');
  } catch (err) {
    threw = true;
  }
  ok(!threw, 'combineFrom: unmatched group name does not throw');
  ok(res.target && res.target.name === null, 'combineFrom: unmatched group name derives a null name');
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
