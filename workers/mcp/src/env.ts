export interface Identity {
  userId: string;
  email?: string;
}
export interface McpEnv extends McpBindings {
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  ALLOWED_SUBS: string;
}
