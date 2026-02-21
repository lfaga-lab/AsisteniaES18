# Asistencia — App para Preceptores (GitHub Pages + Google Sheets)

Esta app usa tu Google Sheet como base de datos (dataset) y te deja:
- Tomar asistencia con UX tipo “Tinder” (PRESENTE / AUSENTE / TARDE / VERIFICAR).
- Tomar lista en días anteriores (selector de fecha).
- Editar asistencia de hoy o de fechas previas.
- Tomar asistencia de Ed. Física a contraturno (tipo de sesión).
- Tomar asistencia en cursos ajenos (queda registrado quién creó la sesión).
- Ver estadísticas (por rango de fechas) y alertas.

---

## 1) Preparar la Google Sheet (tu “DB”)

Tu archivo ya viene con estas pestañas:

- **Users**: `user_id, email, pin, role, full_name, active, created_at`
- **Courses**: `course_id, name, year, division, turno, active`
- **CourseUsers**: `course_id, user_id` (cursos “míos” por usuario)
- **Students**: `student_id, course_id, last_name, first_name, dni, active`
- **Sessions** (se completa sola)
- **Records** (se completa sola)
- **Audit** (se completa sola)

> Importante: dejá los encabezados tal cual.

---

## 2) Backend: Google Apps Script

1. Abrí tu Google Sheet.
2. **Extensiones → Apps Script**
3. Pegá el contenido de `backend/Code.gs` como **Code.gs** (reemplazá lo existente).
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copiá la URL que termina en `/exec`.

---

## 3) Frontend: GitHub Pages

1. Subí la carpeta `frontend/` a tu repo.
2. En `frontend/config.js` pegá la URL `/exec` del WebApp.
3. Activá GitHub Pages (Settings → Pages → Deploy from branch → `/frontend`).

Listo ✅

---

## Notas de uso

- **Tipo de sesión**:
  - `Clase regular` = REGULAR
  - `Ed. Física (contraturno)` = ED_FISICA
- **Alertas**:
  - 3 días consecutivos AUSENTE
  - y cuando llega exactamente a 10/15/20/25/28 faltas (AUSENTE)

Si querés que **TARDE compute como 1/2 falta** o agregar **justificadas**, te lo ajusto.
