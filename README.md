# Asistencia (Google Sheets + Apps Script) + Frontend GitHub Pages

Esta versión NO usa Supabase. Usa:
- Google Sheets como base de datos
- Google Apps Script como API (Web App)
- Frontend estático (GitHub Pages) consumiendo API con **JSONP** (para evitar CORS)

## 1) Crear la base (Google Sheets)
1. Creá una Google Sheet nueva.
2. Extensions → Apps Script
3. Pegá el contenido de `apps_script/Code.gs` y guardá.
4. Volvé a la Sheet y refrescá. Aparece el menú **📌 ASISTENCIA**.
5. Click: **1) Crear estructura de hojas**
6. Opcional: **2) Cargar DEMO** (te deja usuarios/cursos/estudiantes de prueba).

## 2) Publicar el backend (Web App)
Apps Script → Deploy → New deployment → Type: Web app
- Execute as: **Me**
- Who has access: **Anyone**
Copiá la URL que termina en `/exec`.

## 3) Configurar el frontend
En tu repo de GitHub Pages:
- Subí `index.html`, `styles.css`, `config.js`, `app.js`.

Editá `config.js`:
- `WEB_APP_URL: "https://script.google.com/macros/s/...../exec"`

## 4) Logins
Los usuarios se definen en la hoja **Users**:
- email, pin, role (admin o preceptor), full_name, active
Los preceptores se asignan a cursos en **CourseUsers**.

## Estados de asistencia
Se guardan en Records.status:
- present, tardy, absent, pe_present, pe_absent

## Notas
- La pantalla principal no scrollea. Lo largo va en modales.
- “Después” se guarda como “Tarde” al cerrar la toma.
- Justificar NO borra: marca `justified = TRUE` y deja nota.


## Debug
Esta versión agrega un botón **Probar conexión** y muestra el backend en pantalla.
