// Build-time configuration, read by electron-vite from .env (see .env.example).
interface ImportMetaEnv {
  /** Origin of the Oats site that relays sign-in, e.g. https://oats.example.com. */
  readonly MAIN_VITE_AUTH_URL?: string
  /** Origin of the site whose /download/latest/ lists new releases; unset turns update checks off. */
  readonly MAIN_VITE_UPDATE_URL?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
  readonly MAIN_VITE_YANDEX_CLIENT_ID?: string
  readonly MAIN_VITE_YANDEX_CLIENT_SECRET?: string
  readonly MAIN_VITE_OAUTH_PORT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
