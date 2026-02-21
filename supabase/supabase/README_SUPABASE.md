# Asistencia — Supabase (reemplazo completo de Google Sheets)

Esta carpeta te deja la app igual que antes (Tomar lista / Editar / Estadísticas / Alertas) pero con base **Supabase Postgres** + **Edge Function**.

## Qué se corrigió (tu problema)
- En **Estadísticas → Conteo por estudiante** ahora muestra **% de inasistencia** por estudiante (AUSENTE / total) y agrega un orden “Mayor % inasistencia”.

---

## 1) Crear tablas en Supabase

En tu proyecto Supabase:
1. Abrí **SQL Editor**
2. Ejecutá: `supabase/schema.sql`
3. Ejecutá: `supabase/seed.sql` (carga los datos de tu Excel)

> El `seed.sql` se generó desde `Asistencia (1).xlsx` (Users/Courses/Students/etc).

---

## 2) Deploy del Backend (Edge Function)

La función está en:
`supabase/functions/asistencia-api/index.ts`

### Secrets necesarios
En Supabase CLI o Dashboard → **Project Settings → Functions → Secrets**:
- `SUPABASE_URL` = tu url del proyecto (ej: https://xxxx.supabase.co)
- `SUPABASE_SERVICE_ROLE_KEY` = service_role key (NO la pongas en el frontend)

### Deploy (CLI)
```bash
supabase functions deploy asistencia-api
```

---

## 3) Frontend (GitHub Pages)

Subí la carpeta `frontend/` al repo (como venías haciendo).

Editá `frontend/config.js` si cambiás de proyecto:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Listo ✅

---

## Contrato API (compatibilidad)
Se mantiene igual que el Apps Script: el frontend hace `POST` con:
```json
{ "action": "...", "token": "...", "...": "..." }
```

Acciones:
- `login`, `me`
- `getCourses`, `getStudents`
- `getSession`, `closeSession`
- `getRecords`, `updateRecord`, `upsertMany`
- `getStats`, `getStudentStats`
- `getAlerts`

---

## Nota de seguridad
El PIN se guarda en la DB como `pin_hash` (bcrypt vía pgcrypto).  
El `anon key` es público, pero no da acceso directo a tus tablas porque la Edge Function usa `service_role`.

Si después querés activar RLS + Supabase Auth, también se puede.
