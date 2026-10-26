export interface AuthBinding {
  validateToken(token: string): Promise<{ userId: string } | null>;
}
/** Resource bindings come from Wrangler's generated types. */
export interface IngestEnv
  extends Omit<IngestBindings, 'MODEL_EMBED' | 'AI_GATEWAY_ID' | 'AUTH'> {
  AUTH?: AuthBinding;
  /** Optional phase-1 operator credential. Identity is configured, never supplied by HTTP callers. */
  UPLOAD_TOKEN?: string;
  UPLOAD_USER_ID?: string;
  MODEL_EMBED: string;
  AI_GATEWAY_ID: string;
}
