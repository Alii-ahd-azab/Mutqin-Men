import { createClient } from '@supabase/supabase-js';

// Same as Mutqin for Sisters: the browser talks to Supabase directly with the publishable key;
// Row Level Security and the Edge Functions decide what each account may read and change.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error('Supabase environment variables are missing.');
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey);
