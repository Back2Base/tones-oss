export function sentences(text: string): string[] {
  return [
    ...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text),
  ]
    .map((part) => part.segment.trim())
    .filter(Boolean);
}
/** Estimate only. A sentence over maxTokens remains whole and is flagged for review. */
export function segmentText(text: string, minTokens = 150, maxTokens = 400) {
  if (minTokens < 1 || maxTokens < minTokens)
    throw new Error('Invalid chunk limits');
  const chunks: { text: string; tokens: number; oversized: boolean }[] = [];
  let pending = '';
  const tokens = (s: string) => Math.ceil(s.length / 4);
  const flush = () => {
    if (pending)
      chunks.push({
        text: pending,
        tokens: tokens(pending),
        oversized: tokens(pending) > maxTokens,
      });
    pending = '';
  };
  for (const paragraph of text.split(/\n\s*\n/).filter(Boolean)) {
    let first = true;
    for (const sentence of sentences(paragraph)) {
      const separator = first ? '\n\n' : ' ';
      if (pending && tokens(pending + separator + sentence) > maxTokens)
        flush();
      pending += (pending ? separator : '') + sentence;
      first = false;
    }
    if (tokens(pending) >= minTokens) flush();
  }
  flush();
  return chunks;
}
