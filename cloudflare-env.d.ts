declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    POLYMARKET_LIVE_ALLOW_LOCALHOST?: string;
    POLYMARKET_LIVE_ALLOWED_USER_ID?: string;
    POLYMARKET_LIVE_SESSION_SECRET?: string;
    POLYMARKET_LIVE_EXECUTION_ENABLED?: string;
    POLYMARKET_TELEGRAM_SESSION_SECRET?: string;
  }
}
