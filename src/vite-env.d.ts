/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Batch 40: the WhatsApp number / Messenger link the "shop is being
   *  updated" page uses (they can't come from the database). Optional. */
  readonly VITE_FALLBACK_WHATSAPP?: string;
  readonly VITE_FALLBACK_MESSENGER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Batch 31 Part 7: set by vite.config.ts at build time. */
declare const __APP_COMMIT__: string;
declare const __APP_VERSION__: string;
