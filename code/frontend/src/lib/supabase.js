import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = supabaseUrl && supabaseAnonKey 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export const isSupabaseConfigured = () => {
  return Boolean(
    supabaseUrl && 
    supabaseAnonKey && 
    supabase &&
    !supabaseUrl.includes('your-project-id') &&  // Not placeholder URL
    !supabaseAnonKey.includes('your-anon-key') && // Not placeholder key
    supabaseUrl.startsWith('https://') &&         // Valid URL format
    supabaseUrl.includes('.supabase.co')          // Valid Supabase domain
  );
};

export default supabase;
