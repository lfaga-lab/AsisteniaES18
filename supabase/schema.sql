-- Asistencia (Supabase) — esquema base
-- Ejecutar en Supabase SQL Editor (una sola vez)

create extension if not exists pgcrypto;

-- Usuarios (login por email + PIN)
create table if not exists public.users (
  user_id text primary key,
  email text not null unique,
  pin_hash text not null,
  role text not null default 'preceptor',
  full_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Cursos
create table if not exists public.courses (
  course_id text primary key,
  name text not null,
  year int,
  division text,
  turno text,
  active boolean not null default true
);

-- Relación cursos "míos" por usuario
create table if not exists public.course_users (
  course_id text not null references public.courses(course_id) on delete cascade,
  user_id text not null references public.users(user_id) on delete cascade,
  primary key (course_id, user_id)
);

-- Estudiantes
create table if not exists public.students (
  student_id text primary key,
  course_id text not null references public.courses(course_id) on delete cascade,
  last_name text not null,
  first_name text not null,
  dni text,
  active boolean not null default true
);

-- Sesiones (una por curso+fecha+tipo)
create table if not exists public.sessions (
  session_id text primary key, -- ej: SES|C-1A|2026-02-21|REGULAR
  course_id text not null references public.courses(course_id) on delete cascade,
  date date not null,
  status text not null default 'OPEN', -- OPEN/CLOSED
  created_by text not null references public.users(user_id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  context text generated always as (split_part(session_id, '|', 4)) stored
);

-- Registros por estudiante dentro de una sesión
create table if not exists public.records (
  record_id uuid primary key default gen_random_uuid(),
  session_id text not null references public.sessions(session_id) on delete cascade,
  course_id text not null references public.courses(course_id) on delete cascade,
  date date not null,
  student_id text not null references public.students(student_id) on delete cascade,
  status text, -- PRESENTE/AUSENTE/TARDE/VERIFICAR
  justified boolean,
  justified_by text references public.users(user_id),
  justified_at timestamptz,
  note text,
  updated_at timestamptz not null default now(),
  unique (session_id, student_id)
);

-- Auditoría (útil para debugging)
create table if not exists public.audit (
  ts timestamptz not null default now(),
  user_id text references public.users(user_id),
  action text not null,
  payload jsonb
);

-- Tokens de sesión (reemplaza CacheService de Apps Script)
create table if not exists public.tokens (
  token text primary key,
  user_id text not null references public.users(user_id) on delete cascade,
  expires_at timestamptz not null
);

-- Índices
create index if not exists idx_sessions_date on public.sessions(date);
create index if not exists idx_records_date on public.records(date);
create index if not exists idx_records_student on public.records(student_id);
create index if not exists idx_records_session on public.records(session_id);
create index if not exists idx_tokens_expires on public.tokens(expires_at);

-- Función SQL para verificar login (email + PIN) usando pgcrypto
create or replace function public.asistencia_verify_login(p_email text, p_pin text)
returns table(user_id text, email text, role text, full_name text)
language sql
security definer
as $$
  select u.user_id, u.email, u.role, coalesce(u.full_name, u.email) as full_name
  from public.users u
  where lower(u.email) = lower(p_email)
    and u.active is true
    and u.pin_hash = crypt(p_pin, u.pin_hash)
  limit 1;
$$;

-- Nota: RLS queda desactivado a propósito porque este proyecto usa Edge Function con Service Role.
