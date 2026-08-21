-- ============================================================
-- Quiz Helper — Schema PostgreSQL
-- Ejecutar en tu base de datos PostgreSQL del VPS:
--   psql -U tu_usuario -d quiz_helper -f schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    nombre          TEXT NOT NULL,
    nombre_completo TEXT DEFAULT '',
    page_html       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idx             INTEGER NOT NULL,
    html_raw        TEXT DEFAULT '',
    respuesta       TEXT,
    justificacion   TEXT DEFAULT '',
    accion_dinamica TEXT,
    UNIQUE (session_id, idx)
);

CREATE TABLE IF NOT EXISTS mensajes (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_idx    INTEGER NOT NULL,
    from_user       TEXT NOT NULL,
    msg_text        TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);
CREATE INDEX IF NOT EXISTS idx_mensajes_session  ON mensajes(session_id);
