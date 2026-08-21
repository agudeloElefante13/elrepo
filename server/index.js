/**
 * QUIZ HELPER — BACKEND PROPIO (Node.js + PostgreSQL + Socket.io)
 * Reemplaza Supabase PostgREST + Realtime.
 * 
 * Endpoints (mismas rutas que el worker usaba internamente):
 *   POST /api/sessions          — crear sesión
 *   GET  /api/sessions/:id      — sesión completa (admin)
 *   POST /api/sessions/:id/update — actualizar respuesta/justificación/mensaje
 *   GET  /api/sessions/:id/grades — respuestas + justificaciones + mensajes
 *   GET  /api/sessions/:id/status — estado rápido (whoami)
 *   GET  /api/sessions           — lista de sesiones (admin)
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Pool } = require("pg");
const { Server: SocketServer } = require("socket.io");

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// ── PostgreSQL ──────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on("error", (err) => {
    console.error("Error inesperado en el pool de PostgreSQL:", err);
});

// ── Express + Socket.io ─────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Middleware: verificar admin token ───────────────────────
function requireAdmin(req, res, next) {
    const token = req.query.admin_token || req.headers["x-admin-token"];
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
}

// ── Helpers ─────────────────────────────────────────────────
function generateId() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

// ── RSA Decryption (opcional) ───────────────────────────────
async function decryptRSA(str) {
    if (!str) return str;

    if (str.startsWith("OBS:")) {
        try { return decodeURIComponent(atob(str.substring(4).split("").reverse().join(""))); }
        catch (e) { return str; }
    }

    if (str.startsWith("RSA:")) {
        try {
            const privateKeyPem = process.env.PRIVATE_KEY;
            if (!privateKeyPem) return "ERR: NO_PRIVATE_KEY";

            const crypto = require("crypto");
            const b64 = str.substring(4);
            const buffer = Buffer.from(b64, "base64");
            const decrypted = crypto.privateDecrypt(
                {
                    key: privateKeyPem.replace(/\\n/g, "\n"),
                    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: "sha256"
                },
                buffer
            );
            return decrypted.toString("utf-8");
        } catch (e) {
            return "ERR: DECRYPT_FAILED";
        }
    }

    return str;
}

// ═══════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════

// ── POST /api/sessions — Crear sesión ──────────────────────
app.post("/api/sessions", async (req, res) => {
    try {
        const body = req.body;
        const sessionId = generateId();
        const nombre = (await decryptRSA(body.nombre)) || sessionId;
        const nombreCompleto = await decryptRSA(body.nombreCompleto || "");
        const pageHTML = body.pageHTML || null;

        await pool.query(
            `INSERT INTO sessions (id, nombre, nombre_completo, page_html)
             VALUES ($1, $2, $3, $4)`,
            [sessionId, nombre, nombreCompleto, pageHTML]
        );

        // Insertar preguntas en batch
        const questions = body.questions || [];
        if (questions.length > 0) {
            const values = [];
            const params = [];
            questions.forEach((q, i) => {
                const offset = i * 3;
                values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
                params.push(sessionId, i, q.htmlRaw || "");
            });
            await pool.query(
                `INSERT INTO questions (session_id, idx, html_raw) VALUES ${values.join(", ")}`,
                params
            );
        }

        // Notificar a los clientes conectados a esta sesión
        io.to("session:" + sessionId).emit("update", { type: "session_created", sessionId });

        res.json({ ok: true, total: questions.length, sessionId });
    } catch (e) {
        console.error("Error creando sesión:", e);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id — Sesión completa (admin) ────────
app.get("/api/sessions/:id", requireAdmin, async (req, res) => {
    try {
        const sid = req.params.id;

        const [sessRes, questRes, msgRes] = await Promise.all([
            pool.query("SELECT * FROM sessions WHERE id = $1", [sid]),
            pool.query("SELECT * FROM questions WHERE session_id = $1 ORDER BY idx ASC", [sid]),
            pool.query("SELECT * FROM mensajes WHERE session_id = $1 ORDER BY created_at ASC", [sid])
        ]);

        if (sessRes.rows.length === 0) return res.status(404).json({ error: "Session not found" });
        const sess = sessRes.rows[0];
        const allMensajes = msgRes.rows;

        const questionsFormatted = questRes.rows.map(q => ({
            index: q.idx,
            htmlRaw: q.html_raw,
            respuesta: q.respuesta,
            justificacion: q.justificacion,
            accionDinamica: q.accion_dinamica,
            mensajes: allMensajes
                .filter(m => m.question_idx === q.idx)
                .map(m => ({ from: m.from_user, text: m.msg_text, time: m.created_at }))
        }));

        res.json({
            id: sess.id,
            nombre: sess.nombre,
            nombreCompleto: sess.nombre_completo,
            pageHTML: sess.page_html,
            createdAt: sess.created_at,
            questions: questionsFormatted
        });
    } catch (e) {
        console.error("Error obteniendo sesión:", e);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/sessions/:id/update — Actualizar respuesta/justificación/mensaje ──
app.post("/api/sessions/:id/update", async (req, res) => {
    try {
        const sid = req.params.id;
        const body = req.body;
        const idx = body.questionIndex;
        const promises = [];

        // Actualizar campos de la pregunta
        const setClauses = [];
        const setValues = [];
        let paramIdx = 1;

        if (body.letra !== undefined) {
            setClauses.push(`respuesta = $${paramIdx++}`);
            setValues.push(body.letra);
        }
        if (body.justificacion !== undefined) {
            setClauses.push(`justificacion = $${paramIdx++}`);
            setValues.push(body.justificacion);
        }
        if (body.accionDinamica !== undefined) {
            setClauses.push(`accion_dinamica = $${paramIdx++}`);
            setValues.push(body.accionDinamica);
            setClauses.push(`respuesta = $${paramIdx++}`);
            setValues.push("done");
        }

        if (setClauses.length > 0) {
            setValues.push(sid, idx);
            promises.push(
                pool.query(
                    `UPDATE questions SET ${setClauses.join(", ")} WHERE session_id = $${paramIdx++} AND idx = $${paramIdx++}`,
                    setValues
                )
            );
        }

        // Insertar mensaje si viene
        if (body.mensaje) {
            promises.push(
                pool.query(
                    `INSERT INTO mensajes (session_id, question_idx, from_user, msg_text) VALUES ($1, $2, $3, $4)`,
                    [sid, idx, body.mensaje.from, body.mensaje.text]
                )
            );
        }

        if (promises.length > 0) await Promise.all(promises);

        // Notificar a los clientes conectados a esta sesión
        io.to("session:" + sid).emit("update", {
            type: "question_updated",
            sessionId: sid,
            questionIndex: idx
        });

        res.json({ ok: true });
    } catch (e) {
        console.error("Error actualizando sesión:", e);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/grades — Respuestas + justificaciones + mensajes ──
app.get("/api/sessions/:id/grades", async (req, res) => {
    try {
        const sid = req.params.id;

        const [questRes, msgRes, sessRes] = await Promise.all([
            pool.query("SELECT * FROM questions WHERE session_id = $1 ORDER BY idx ASC", [sid]),
            pool.query("SELECT * FROM mensajes WHERE session_id = $1 ORDER BY created_at ASC", [sid]),
            pool.query("SELECT created_at FROM sessions WHERE id = $1", [sid])
        ]);

        if (questRes.rows.length === 0) return res.status(404).json({ error: "Session not found" });

        const questions = questRes.rows;
        const allMensajes = msgRes.rows;

        res.json({
            answers: questions.map(q => q.respuesta),
            justificaciones: questions.map(q => q.justificacion || ""),
            mensajes: questions.map(q =>
                allMensajes
                    .filter(m => m.question_idx === q.idx)
                    .map(m => ({ from: m.from_user, text: m.msg_text, time: m.created_at }))
            ),
            accionesDinamicas: questions.map(q => q.accion_dinamica || null),
            createdAt: sessRes.rows[0]?.created_at
        });
    } catch (e) {
        console.error("Error obteniendo grades:", e);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/sessions/:id/status — Estado rápido (whoami) ──
app.get("/api/sessions/:id/status", requireAdmin, async (req, res) => {
    try {
        const sid = req.params.id;

        const [sessRes, questRes] = await Promise.all([
            pool.query("SELECT * FROM sessions WHERE id = $1", [sid]),
            pool.query("SELECT respuesta FROM questions WHERE session_id = $1", [sid])
        ]);

        if (sessRes.rows.length === 0) return res.json({ active: false });
        const sess = sessRes.rows[0];

        res.json({
            active: true,
            createdAt: sess.created_at,
            nombre: sess.nombre || sess.id,
            nombreCompleto: sess.nombre_completo || "",
            total: questRes.rows.length,
            answered: questRes.rows.filter(q => q.respuesta).length
        });
    } catch (e) {
        res.json({ active: false });
    }
});

// ── GET /api/sessions — Lista de sesiones (admin) ──────────
app.get("/api/sessions", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.nombre, s.nombre_completo, s.created_at,
                   COUNT(q.id) AS total,
                   COUNT(q.respuesta) AS answered
            FROM sessions s
            LEFT JOIN questions q ON q.session_id = s.id
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT 30
        `);

        const sessions = result.rows.map(s => ({
            id: s.id,
            nombre: s.nombre || s.id,
            nombreCompleto: s.nombre_completo || "",
            createdAt: s.created_at,
            total: parseInt(s.total),
            answered: parseInt(s.answered)
        }));

        res.json({ sessions });
    } catch (e) {
        console.error("Error listando sesiones:", e);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// SOCKET.IO — Realtime
// ═══════════════════════════════════════════════════════════
io.on("connection", (socket) => {
    // Clientes se unen a una "room" para su sesión
    socket.on("join", (sessionId) => {
        if (sessionId) {
            socket.join("session:" + sessionId);
        }
    });

    socket.on("leave", (sessionId) => {
        if (sessionId) {
            socket.leave("session:" + sessionId);
        }
    });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
server.listen(PORT, () => {
    console.log(`✅ Quiz Helper Server corriendo en puerto ${PORT}`);
});
