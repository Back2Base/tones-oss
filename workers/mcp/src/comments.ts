import type { Register } from '../../../packages/shared/src/index.ts';
import type { McpEnv } from './env.ts';
import type { Target, Targets } from './profile.ts';
import { embedQueries, findExemplars, loadReadyProfile } from './retrieval.ts';
// Prose targets that still describe a one-line comment; paragraph and
// vocabulary-diversity measures are noise at this length.
const COMMENT_TARGETS = [
  'sentenceLength.p50',
  'wordLengthMean',
  'contractionsPer100',
] as const;
const GUIDE_KEYS = ['voice', 'rules', 'avoid'] as const;
const EXCERPT_CHARS = 600;
export const COMMENT_INSTRUCTION =
  'Rewrite each comment yourself in my voice, using this context. Keep identifiers, code references, paths, TODO/FIXME tags, comment markers, and meaning unchanged. Keep each comment about as short as the original. Never use em dashes.';
const round = (n: number, places = 2) => Number(n.toFixed(places));
// Exemplars are prose paragraphs; a few leading sentences show the voice.
function excerpt(text: string) {
  if (text.length <= EXCERPT_CHARS) return text;
  const head = text.slice(0, EXCERPT_CHARS);
  const end = Math.max(
    ...['. ', '? ', '! ', '\n'].map((mark) => head.lastIndexOf(mark)),
  );
  return end > EXCERPT_CHARS / 3
    ? head.slice(0, end + 1).trim()
    : `${head.trimEnd()}...`;
}
// Mean of unit vectors; cosine search ignores the result's length.
function centroid(vectors: number[][]) {
  const sum = new Array<number>(vectors[0]!.length).fill(0);
  for (const vector of vectors) {
    const norm = Math.hypot(...vector) || 1;
    vector.forEach((n, i) => (sum[i]! += n / norm));
  }
  return sum;
}
export async function getCommentStyle(
  env: McpEnv,
  userId: string,
  comments: string[],
  register: Register,
  k: number,
) {
  const profile = await loadReadyProfile(env, userId, register);
  const vectors = await embedQueries(env, [...new Set(comments)]);
  const exemplars = await findExemplars(
    env,
    userId,
    register,
    profile.targets,
    centroid(vectors),
    k,
    true,
  );
  const targets: Targets = {};
  for (const key of COMMENT_TARGETS) {
    const target = profile.targets[key];
    if (target)
      targets[key] = Object.fromEntries(
        Object.entries(target).map(([name, n]) => [name, round(n)]),
      ) as Target;
  }
  return {
    profileVersion: profile.profileVersion,
    register,
    source: profile.source,
    commentCount: comments.length,
    guide: Object.fromEntries(
      GUIDE_KEYS.filter((key) => key in profile.guide).map((key) => [
        key,
        profile.guide[key],
      ]),
    ),
    targets,
    hardRules: profile.hardRules,
    exemplars: exemplars.map((x) => ({
      text: excerpt(x.text),
      sampleTitle: x.sampleTitle,
      score: round(x.score, 3),
    })),
    instruction: COMMENT_INSTRUCTION,
  };
}
