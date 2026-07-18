const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isSafeExternalUrl } = require('../src/common/url-safety');

// linkify.js is a browser ES module living under a project whose
// package.json declares "type": "commonjs". A plain `import()` of the file
// by path (even via pathToFileURL) is resolved as CommonJS by Node and
// fails on the `export` syntax, regardless of how this test file itself is
// loaded — see test/resizer-clamp.test.js for the same issue with
// resizer.js. Reading the source and importing it as a data: URL with an
// explicit text/javascript MIME type sidesteps that package.json-based
// module-type detection. linkify.js has no imports of its own, so this is
// safe.
async function loadLinkifyModule() {
  const linkifyPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'linkify.js');
  const source = fs.readFileSync(linkifyPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

test('segmentText: plain text with no url', async () => {
  const { segmentText } = await loadLinkifyModule();
  const text = 'just some plain text, nothing to see here';
  assert.deepStrictEqual(segmentText(text), [{ type: 'text', value: text }]);
});

test('segmentText: url surrounded by text', async () => {
  const { segmentText } = await loadLinkifyModule();
  assert.deepStrictEqual(segmentText('see http://a.com now'), [
    { type: 'text', value: 'see ' },
    { type: 'link', value: 'http://a.com' },
    { type: 'text', value: ' now' },
  ]);
});

test('segmentText: trailing punctuation trimmed off the link', async () => {
  const { segmentText } = await loadLinkifyModule();
  assert.deepStrictEqual(segmentText('http://a.com.'), [
    { type: 'link', value: 'http://a.com' },
    { type: 'text', value: '.' },
  ]);
});

test('segmentText: url wrapped in parens', async () => {
  const { segmentText } = await loadLinkifyModule();
  assert.deepStrictEqual(segmentText('(https://a.com/x)'), [
    { type: 'text', value: '(' },
    { type: 'link', value: 'https://a.com/x' },
    { type: 'text', value: ')' },
  ]);
});

test('segmentText: ftp and bare www are not linkified', async () => {
  const { segmentText } = await loadLinkifyModule();
  const text = 'ftp://x.com and www.y.com';
  assert.deepStrictEqual(segmentText(text), [{ type: 'text', value: text }]);
});

test('segmentText: two urls in one string', async () => {
  const { segmentText } = await loadLinkifyModule();
  const result = segmentText('http://a.com and https://b.com');
  const links = result.filter((s) => s.type === 'link');
  assert.strictEqual(links.length, 2);
  assert.strictEqual(links[0].value, 'http://a.com');
  assert.strictEqual(links[1].value, 'https://b.com');
});

test('segmentText: empty string', async () => {
  const { segmentText } = await loadLinkifyModule();
  assert.deepStrictEqual(segmentText(''), []);
});

test('segmentText: image-extension url is tagged type "image"', async () => {
  const { segmentText } = await loadLinkifyModule();
  assert.deepStrictEqual(segmentText('see https://a.com/cat.png now'), [
    { type: 'text', value: 'see ' },
    { type: 'image', value: 'https://a.com/cat.png' },
    { type: 'text', value: ' now' },
  ]);
});

test('segmentText: image url with query string is still tagged "image"', async () => {
  const { segmentText } = await loadLinkifyModule();
  const result = segmentText('https://a.com/cat.jpg?w=200&h=100');
  assert.deepStrictEqual(result, [
    { type: 'image', value: 'https://a.com/cat.jpg?w=200&h=100' },
  ]);
});

test('segmentText: recognizes all supported image extensions, case-insensitively', async () => {
  const { segmentText } = await loadLinkifyModule();
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'PNG', 'JPG']) {
    const [seg] = segmentText(`https://a.com/x.${ext}`);
    assert.strictEqual(seg.type, 'image', `expected .${ext} to be an image`);
  }
});

test('segmentText: non-image url stays type "link"', async () => {
  const { segmentText } = await loadLinkifyModule();
  const [seg] = segmentText('https://a.com/page.html');
  assert.strictEqual(seg.type, 'link');
});

test('isImageUrl: accepts known extensions, rejects everything else', async () => {
  const { isImageUrl } = await loadLinkifyModule();
  assert.strictEqual(isImageUrl('https://a.com/cat.png'), true);
  assert.strictEqual(isImageUrl('https://a.com/cat.png?x=1'), true);
  assert.strictEqual(isImageUrl('https://a.com/cat.png#frag'), true);
  assert.strictEqual(isImageUrl('https://a.com/page.html'), false);
  assert.strictEqual(isImageUrl('https://a.com/no-extension'), false);
  assert.strictEqual(isImageUrl(''), false);
  assert.strictEqual(isImageUrl(null), false);
});

test('isImageUrl: rejects private/loopback/link-local hosts (SSRF/LAN-probe guard)', async () => {
  const { isImageUrl } = await loadLinkifyModule();
  const blocked = [
    'http://localhost/x.png',
    'http://LOCALHOST/x.png',
    'http://sub.localhost/x.png',
    'http://127.0.0.1/x.png',
    'http://127.1/x.png',              // short-form IPv4, normalizes to 127.0.0.1
    'http://0x7f000001/x.png',         // hex IPv4, normalizes to 127.0.0.1
    'http://017700000001/x.png',       // octal IPv4, normalizes to 127.0.0.1
    'http://10.0.0.5/x.png',
    'http://172.16.0.1/x.png',
    'http://172.31.255.255/x.png',
    'http://192.168.1.1/x.png',
    'http://169.254.169.254/x.png',    // cloud metadata endpoint
    'http://0.0.0.0/x.png',
    'http://[::1]/x.png',
    'http://[fe80::1]/x.png',
    'http://[fc00::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
  ];
  for (const url of blocked) {
    assert.strictEqual(isImageUrl(url), false, `expected ${url} to be blocked`);
  }
});

test('isImageUrl: accepts ordinary public hosts, including adjacent-but-not-private ranges', async () => {
  const { isImageUrl } = await loadLinkifyModule();
  const allowed = [
    'https://upload.wikimedia.org/x.png',
    'https://example.com/x.jpg',
    'http://172.15.255.255/x.png',   // just below the 172.16.0.0/12 block
    'http://172.32.0.0/x.png',       // just above the 172.16.0.0/12 block
    'http://11.0.0.1/x.png',         // not 10.0.0.0/8
    'http://169.253.0.1/x.png',      // not 169.254.0.0/16
  ];
  for (const url of allowed) {
    assert.strictEqual(isImageUrl(url), true, `expected ${url} to be allowed`);
  }
});

test('segmentText: image url with a private/loopback host degrades to type "link"', async () => {
  const { segmentText } = await loadLinkifyModule();
  const [seg] = segmentText('http://192.168.1.1/photo.png');
  assert.strictEqual(seg.type, 'link');
});

test('isSafeExternalUrl: accepts http/https (case-insensitive scheme)', () => {
  assert.strictEqual(isSafeExternalUrl('http://a.com'), true);
  assert.strictEqual(isSafeExternalUrl('https://a.com/x?y=1'), true);
  assert.strictEqual(isSafeExternalUrl('HTTP://A.com'), true);
});

test('isSafeExternalUrl: rejects everything else', () => {
  assert.strictEqual(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.strictEqual(isSafeExternalUrl('file:///etc/passwd'), false);
  assert.strictEqual(isSafeExternalUrl('mailto:x@y.com'), false);
  assert.strictEqual(isSafeExternalUrl('ftp://a.com'), false);
  assert.strictEqual(isSafeExternalUrl('data:text/html,x'), false);
  assert.strictEqual(isSafeExternalUrl('notaurl'), false);
  assert.strictEqual(isSafeExternalUrl(''), false);
  assert.strictEqual(isSafeExternalUrl(null), false);
});
