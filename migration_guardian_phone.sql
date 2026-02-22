-- Agrega celular del adulto responsable
alter table if exists public.students
  add column if not exists guardian_phone text;
