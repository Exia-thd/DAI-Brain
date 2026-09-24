import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeAttachmentName, parseAttachments, humanSize } from '../shared/dist/index.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const LIMITS = { maxCount: 3, maxTotalBytes: 64 };

test('a name can only ever name a file', () => {
  // The whole reason this function exists: the name arrives in a request body
  // and is about to be joined to a directory path.
  assert.equal(safeAttachmentName('../../etc/passwd', 0), 'etcpasswd');
  assert.equal(safeAttachmentName('..', 0), 'file-1');
  assert.equal(safeAttachmentName('.', 0), 'file-1');
  assert.equal(safeAttachmentName('/etc/shadow', 0), 'etcshadow');
  assert.equal(safeAttachmentName('C:\\Windows\\win.ini', 0), 'CWindowswin.ini');
  assert.equal(safeAttachmentName('.bashrc', 0), 'bashrc');
  assert.equal(safeAttachmentName('a\u0000b.txt', 0), 'ab.txt');
  assert.equal(safeAttachmentName('re:port|1?.txt', 0), 'report1.txt');
});

test('a name that is not a name falls back to a numbered one', () => {
  assert.equal(safeAttachmentName('', 0), 'file-1');
  assert.equal(safeAttachmentName('   ', 4), 'file-5');
  assert.equal(safeAttachmentName(undefined, 1), 'file-2');
  assert.equal(safeAttachmentName(42, 1), 'file-2');
});

test('a long name is truncated but keeps its extension', () => {
  const name = safeAttachmentName(`${'a'.repeat(300)}.png`, 0);
  assert.equal(name.length, 100);
  assert.ok(name.endsWith('.png'), name.slice(-10));
});

test('ordinary names, including non-ASCII ones, are left alone', () => {
  assert.equal(safeAttachmentName('báo-cáo quý 4.pdf', 0), 'báo-cáo quý 4.pdf');
  assert.equal(safeAttachmentName('error.log', 0), 'error.log');
});

test('attachments decode, and a data URL prefix is not part of the data', () => {
  const [one] = parseAttachments([{ name: 'a.txt', data: b64('hello') }], LIMITS);
  assert.equal(Buffer.from(one.bytes).toString('utf8'), 'hello');

  const [two] = parseAttachments(
    [{ name: 'b.png', data: `data:image/png;base64,${b64('hello')}` }], LIMITS);
  assert.equal(Buffer.from(two.bytes).toString('utf8'), 'hello');
});

test('two files of one name stay two files', () => {
  // Same name means one file on disk, and an answer about whichever was
  // written last, with nothing to show that happened.
  const out = parseAttachments([
    { name: 'log.txt', data: b64('first') },
    { name: 'log.txt', data: b64('second') },
    { name: '../log.txt', data: b64('third') },
  ], LIMITS);
  assert.deepEqual(out.map((a) => a.name), ['log.txt', 'log-2.txt', 'log-3.txt']);
});

test('the limits are refusals, not exceptions', () => {
  const tooMany = Array.from({ length: 4 }, () => ({ name: 'a', data: b64('x') }));
  assert.throws(() => parseAttachments(tooMany, LIMITS), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /more than the 3 allowed/);
    return true;
  });

  const tooBig = [{ name: 'a', data: b64('x'.repeat(65)) }];
  assert.throws(() => parseAttachments(tooBig, LIMITS), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /limit for one message/);
    return true;
  });

  // The cap is on the decoded length; base64 is a third larger than what it
  // encodes, so checking the string would set the limit a third too high.
  const justUnder = [{ name: 'a', data: b64('x'.repeat(64)) }];
  assert.equal(parseAttachments(justUnder, LIMITS).length, 1);
});

test('malformed input is a 400, never a crash', () => {
  assert.deepEqual(parseAttachments(undefined, LIMITS), []);
  assert.deepEqual(parseAttachments(null, LIMITS), []);
  assert.throws(() => parseAttachments('nope', LIMITS), /must be an array/);
  assert.throws(() => parseAttachments([{ name: 'a' }], LIMITS), /has no data/);
  assert.throws(() => parseAttachments([null], LIMITS), /has no data/);
  assert.throws(() => parseAttachments([{ name: 'a', data: 'not base64!!' }], LIMITS),
    /not valid base64/);
});

test('a media type the browser invented is not trusted into the filesystem', () => {
  const [one] = parseAttachments([{ name: 'a', data: b64('x'), type: 'x'.repeat(200) }], LIMITS);
  assert.equal(one.type, 'application/octet-stream');
  const [two] = parseAttachments([{ name: 'a', data: b64('x') }], LIMITS);
  assert.equal(two.type, 'application/octet-stream');
});

test('sizes read as sizes', () => {
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
});
