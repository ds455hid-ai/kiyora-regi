export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
export const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()
export const IS_MOCK = import.meta.env.VITE_BACKEND === 'mock'
export const IS_CONFIGURED = IS_MOCK || (SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '')
export const APP_VERSION = '2.0.0'
