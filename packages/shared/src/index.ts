export const REGISTERS = [
  'casual',
  'professional',
  'documentation',
  'social',
  'general',
] as const;
export type Register = (typeof REGISTERS)[number];
// One line per category; the classifier, tool schemas, and collect_writing prompt all read these.
export const REGISTER_DESCRIPTIONS: Record<Register, string> = {
  casual:
    'chat and quick messages to people I know: Slack, Discord, texts, comments',
  professional:
    'work correspondence: email, proposals, status updates, cover letters',
  documentation:
    'docs, READMEs, guides, specs, design docs, technical explanations',
  social: 'public posts: social media, blog posts, newsletters, forum posts',
  general:
    'anything else, or a mix; general style context draws on every category',
};
export type SampleStatus = 'pending' | 'processing' | 'ready' | 'failed';
export interface IngestParams {
  userId: string;
  sampleId: string;
  key: string;
  register: Register;
}
export function isRegister(value: unknown): value is Register {
  return (
    typeof value === 'string' &&
    (REGISTERS as readonly string[]).includes(value)
  );
}
export const LIMITS = {
  uploadBytes: 25 * 1024 * 1024,
  sampleMinChars: 200,
  sampleMaxChars: 200000,
  rewriteMaxChars: 20000,
  commentMaxItems: 50,
  commentMaxChars: 2000,
} as const;
