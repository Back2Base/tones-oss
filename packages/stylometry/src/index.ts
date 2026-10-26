import { CONTRACTIONS, FUNCTION_WORDS, REFERENCE_TEXT } from './lexicons.ts';
const words = (text: string) => text.match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? [];
const sentences = (text: string) =>
  [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map((s) => s.segment.trim())
    .filter((s) => words(s).length);
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
function distribution(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const average = mean(xs);
  const quantile = (p: number) =>
    sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0;
  return {
    mean: average,
    stdev: Math.sqrt(mean(xs.map((n) => (n - average) ** 2))),
    p10: quantile(0.1),
    p25: quantile(0.25),
    p50: quantile(0.5),
    p75: quantile(0.75),
    p90: quantile(0.9),
  };
}
function ngrams(ws: string[]) {
  const counts: Record<string, number> = {};
  for (let n = 2; n <= 4; n++)
    for (let i = 0; i <= ws.length - n; i++) {
      const key = ws.slice(i, i + n).join(' ');
      counts[key] = (counts[key] ?? 0) + 1;
    }
  return counts;
}
const baseline = ngrams(words(REFERENCE_TEXT).map((w) => w.toLowerCase()));
export function extractFeatures(text: string) {
  const ws = words(text);
  const lower = ws.map((w) => w.toLowerCase().replace(/’/g, "'"));
  const ss = sentences(text);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => words(p).length);
  const per1k = (n: number) => (ws.length ? (n * 1000) / ws.length : 0);
  const punctuationCounts: Record<string, number> = Object.fromEntries(
    ['—', '–', ';', ',', ':', '!', '?', '(', ')', '"', "'"].map((mark) => [
      mark,
      text.split(mark).length - 1,
    ]),
  );
  punctuationCounts.ellipsis = (text.match(/…|\.{3}/g) ?? []).length;
  punctuationCounts.hyphenated_compound = (
    text.match(/\p{L}+(?:-\p{L}+)+/gu) ?? []
  ).length;
  const ttrs: number[] = [];
  if (ws.length < 100 && ws.length) ttrs.push(new Set(lower).size / ws.length);
  else
    for (let i = 0; i <= ws.length - 100 && ws.length; i++)
      ttrs.push(new Set(lower.slice(i, i + 100)).size / 100);
  const openerCounts: Record<string, number> = {};
  for (const sentence of ss) {
    const key = words(sentence).slice(0, 3).join(' ').toLowerCase();
    openerCounts[key] = (openerCounts[key] ?? 0) + 1;
  }
  const top = (counts: Record<string, number>, limit = 20) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
      .slice(0, limit)
      .map(([text, count]) => ({ text, count }));
  const counts = ngrams(lower);
  const signatures = Object.fromEntries(
    Object.entries(counts).filter(
      ([key, n]) =>
        n >= 3 &&
        n / Math.max(1, ws.length) >
          (3 * ((baseline[key] ?? 0) + 0.5)) / words(REFERENCE_TEXT).length,
    ),
  );
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    version: 1,
    wordCount: ws.length,
    sentenceLength: distribution(ss.map((s) => words(s).length)),
    paragraphLength: distribution(paragraphs.map((p) => sentences(p).length)),
    wordLengthMean: mean(ws.map((w) => [...w].length)),
    movingAverageTtr: mean(ttrs),
    punctuationPer1k: Object.fromEntries(
      Object.entries(punctuationCounts).map(([k, v]) => [k, per1k(v)]),
    ),
    contractionsPer100: ws.length
      ? (lower.filter((w) => CONTRACTIONS.has(w)).length * 100) / ws.length
      : 0,
    lowercaseSentenceShare: ss.length
      ? ss.filter((s) => /^\p{Ll}/u.test(s.replace(/^[^\p{L}]+/u, ''))).length /
        ss.length
      : 0,
    allCapsPer1k: per1k(
      ws.filter((w) => w.length > 1 && /^\p{Lu}+$/u.test(w)).length,
    ),
    usesLists: lines.some((s) => /^(?:[-*+]\s+|\d+[.)]\s+)/.test(s)),
    functionWordFrequencies: Object.fromEntries(
      FUNCTION_WORDS.map((w) => [
        w,
        ws.length ? lower.filter((x) => x === w).length / ws.length : 0,
      ]),
    ),
    openers: top(openerCounts),
    greetings: lines
      .filter((s) => /^(hi|hey|hello|dear)\b/i.test(s))
      .slice(0, 20),
    signoffs: lines
      .filter((s) =>
        /^(thanks|thank you|best|regards|cheers|sincerely)[,!\s]*$/i.test(s),
      )
      .slice(-20),
    signaturePhrases: top(signatures),
    signatureReference: 'bundled-neutral-v1',
    emojiPer1k: per1k(
      [
        ...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text),
      ].filter((s) =>
        /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s.segment),
      ).length,
    ),
  };
}
export function checkPunctuationBans(
  text: string,
  banned: string[] = ['—'],
): string[] {
  return banned
    .filter((mark) => text.includes(mark))
    .map((mark) => `Banned punctuation: ${mark}`);
}
