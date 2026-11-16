-- Allow trusted Supabase Dashboard-created users to receive a valid app profile.
-- App sign-up still supplies username/name in auth metadata; the email fallback
-- supports the project's internal username@users.handle.local identities.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_username text := lower(btrim(coalesce(
    NEW.raw_user_meta_data ->> 'username',
    split_part(NEW.email, '@', 1),
    ''
  )));
  v_name text := btrim(coalesce(
    NEW.raw_user_meta_data ->> 'name',
    initcap(replace(split_part(NEW.email, '@', 1), '_', ' ')),
    ''
  ));
BEGIN
  IF v_username !~ '^[a-z0-9_.]{3,20}$' THEN
    RAISE EXCEPTION 'INVALID_USERNAME' USING ERRCODE = '23514';
  END IF;
  IF char_length(v_name) = 0 OR char_length(v_name) > 50 THEN
    RAISE EXCEPTION 'INVALID_NAME' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.profiles (id, username, name)
  VALUES (NEW.id, v_username, v_name);
  RETURN NEW;
END;
$$;
