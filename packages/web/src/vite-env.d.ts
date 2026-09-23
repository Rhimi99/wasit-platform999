/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" only on the public-demo build; unset for production. */
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
