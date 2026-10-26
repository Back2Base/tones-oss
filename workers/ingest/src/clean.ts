/** Conservative cleanup; user-configured signature markers are literal full lines. */
export function cleanText(input: string, signatureMarkers: string[] = []) {
  const kept: string[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    if (
      /^On .+wrote:\s*$/i.test(line.trim()) ||
      /^-- $/.test(line) ||
      signatureMarkers.includes(line.trim())
    )
      break;
    if (/^\s*>/.test(line) || /^\s*https?:\/\/\S+\s*$/.test(line)) continue;
    kept.push(line.trimEnd());
  }
  return kept
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
