import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../workers/ingest/src/clean.ts';
import { segmentText } from '../workers/ingest/src/segment.ts';
import {
  extractFeatures,
  checkPunctuationBans,
} from '../packages/stylometry/src/index.ts';
import { isRegister } from '../packages/shared/src/index.ts';
test('cleanup removes replies, code, links and signature', () => {
  assert.equal(
    cleanText(
      'Hello.\r\n\r\n> quoted\nhttps://example.com\n```js\nsecret()\n```\n-- \nSignature',
    ),
    'Hello.',
  );
  assert.equal(
    cleanText('My words.\nOn Tuesday, Alex wrote:\nold reply'),
    'My words.',
  );
});
test('sentence chunking preserves all words and flags oversized sentences', () => {
  const sentence = 'This is one complete sentence. ';
  const input = sentence.repeat(120).trim();
  const chunks = segmentText(input);
  assert.equal(chunks.map((c) => c.text).join(' '), input);
  assert.ok(chunks.every((c) => c.tokens <= 400 && c.text.endsWith('.')));
  assert.equal(segmentText('word '.repeat(500) + '.')[0].oversized, true);
  assert.deepEqual(segmentText(''), []);
  assert.throws(() => segmentText('text', 400, 100));
});
test('feature extraction uses word counts and handles empty input', () => {
  const features = extractFeatures('Hello there. I write clearly!');
  assert.equal(features.wordCount, 5);
  assert.equal(features.sentenceLength.mean, 2.5);
  assert.equal(features.punctuationPer1k['!'], 200);
  assert.equal(extractFeatures('').movingAverageTtr, 0);
  assert.equal(extractFeatures('go '.repeat(100)).movingAverageTtr, 0.01);
});
test('default punctuation rule and register validation', () => {
  assert.equal(checkPunctuationBans('Hello—there').length, 1);
  assert.deepEqual(checkPunctuationBans('Hello there'), []);
  assert.equal(isRegister('casual'), true);
  assert.equal(isRegister('arbitrary'), false);
});

test('stylometry captures contractions, paragraphs, lists, casing and emoji', () => {
  const f = extractFeatures(
    "hey team, here's the plan. we'll ship it!\n\n- Review the API response.\n\nI don't want another meeting. Thanks 🙂",
  );
  assert.equal(f.usesLists, true);
  assert.ok(f.contractionsPer100 > 0);
  assert.ok(f.lowercaseSentenceShare > 0);
  assert.ok(f.allCapsPer1k > 0);
  assert.ok(f.emojiPer1k > 0);
  assert.ok(f.paragraphLength.mean > 0);
  assert.equal(Object.keys(f.functionWordFrequencies).length, 50);
});

test('stylometry matches the fixed text golden fixture', () => {
  const fixture = readFileSync(
    new URL('./fixtures/style.txt', import.meta.url),
    'utf8',
  );
  const expected = JSON.parse(
    readFileSync(
      new URL('./fixtures/style.features.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(extractFeatures(fixture), expected);
});

test('cleanup drops unclosed and tilde code fences and honors signature markers', () => {
  assert.equal(
    cleanText('Keep this.\n~~~js\nignored\n~~~\nNext sentence.'),
    'Keep this.\nNext sentence.',
  );
  assert.equal(cleanText('Keep this.\n```\nprivate code'), 'Keep this.');
  assert.equal(
    cleanText('Keep this.\nSent from my phone\nfooter', ['Sent from my phone']),
    'Keep this.',
  );
});
