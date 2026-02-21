create extension if not exists pgcrypto;

create or replace function public.asistencia_verify_login(p_email text, p_pin text)
returns table(user_id text, email text, role text, full_name text)
language sql
security definer
as $$
  select u.user_id, u.email, u.role, coalesce(u.full_name, u.email) as full_name
  from public.users u
  where lower(u.email) = lower(p_email)
    and coalesce(u.active,true) is true
    and u.pin_hash = crypt(p_pin, u.pin_hash)
  limit 1;
$$;
