-- Migración v3: tabla de alertas avisadas (ack)
create table if not exists public.as_alerts_ack (
  student_id text not null references public.as_students(student_id) on delete cascade,
  course_id text not null references public.as_courses(course_id) on delete cascade,
  context text not null default 'ALL',
  acked_until_date date not null,
  acked_by text references public.as_users(user_id),
  acked_at timestamptz not null default now(),
  primary key (student_id, course_id, context)
);

create index if not exists idx_alerts_ack_course on public.as_alerts_ack(course_id, context);
