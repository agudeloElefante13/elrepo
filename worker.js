/**
 * CLOUDFLARE WORKER — QUIZ HELPER (v5: SUPABASE EDITION)
 * Migrado de Cloudflare KV a Supabase PostgreSQL.
 * Backend: REST API (PostgREST) via fetch().
 * Frontend: Recibe credenciales inyectadas para Realtime WebSockets.
 */

const GITHUB_BASE = "https://raw.githubusercontent.com/agudeloElefante13/elrepo/main";
const GITHUB_TOKEN = "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";

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
};

function jsonRes(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }
    });
}

async function fetchGitHub(file) {
    const res = await fetch(GITHUB_BASE + "/" + file, {
        headers: { "Authorization": "token " + GITHUB_TOKEN },
        cache: "no-store"
    });
    if (!res.ok) return null;
    return await res.text();
}

function generateId() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/(-----(BEGIN|END) (PUBLIC|PRIVATE) KEY-----|\n|\r)/g, '');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

async function decryptRSA(env, str) {
    if (!str) return str;

    if (str.startsWith("OBS:")) {
        try { return decodeURIComponent(atob(str.substring(4).split('').reverse().join(''))); }
        catch (e) { return str; }
    }

    if (str.startsWith("RSA:")) {
        try {
            if (!env.PRIVATE_KEY) return "ERR: NO_PRIVATE_KEY_IN_CLOUDFLARE";
            const b64 = str.substring(4);
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const cryptoAPI = globalThis.crypto;
            const privateKey = await cryptoAPI.subtle.importKey(
                "pkcs8",
                pemToArrayBuffer(env.PRIVATE_KEY),
                { name: "RSA-OAEP", hash: "SHA-256" },
                false,
                ["decrypt"]
            );

            const decrypted = await cryptoAPI.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, bytes.buffer);
            return new TextDecoder().decode(decrypted);
        } catch (e) {
            return "ERR: DECRYPT_FAILED";
        }
    }

    return str; // Not encrypted
}

/**
 * Supabase REST API (PostgREST) helper.
 * Usa el service_role key para acceso total desde el backend.
 */
async function supa(env, path, options = {}) {
    const res = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, {
        method: options.method || "GET",
        headers: {
            "apikey": env.SUPABASE_KEY,
            "Authorization": "Bearer " + env.SUPABASE_KEY,
            "Content-Type": "application/json",
            ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error("Supabase " + res.status + ": " + errText);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS });
        }

        const adminToken = url.searchParams.get("admin_token");
        const isAdmin = env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN;

        // ── POST /api/session — Crear sesión ──
        if (path === "/api/session" && request.method === "POST") {
            try {
                const body = await request.json();
                const sessionId = generateId();
                const nombre = (await decryptRSA(env, body.nombre)) || sessionId;

                // Insertar sesión
                await supa(env, "sessions", {
                    method: "POST",
                    headers: { "Prefer": "return=minimal" },
                    body: {
                        id: sessionId,
                        nombre,
                        nombre_completo: await decryptRSA(env, body.nombreCompleto || ""),
                        page_html: body.pageHTML || null
                    }
                });

                // Insertar preguntas en batch
                const questions = body.questions.map((q, i) => ({
                    session_id: sessionId,
                    idx: i,
                    html_raw: q.htmlRaw || "",
                    respuesta: null,
                    justificacion: "",
                    accion_dinamica: null
                }));

                await supa(env, "questions", {
                    method: "POST",
                    headers: { "Prefer": "return=minimal" },
                    body: questions
                });

                return jsonRes({ ok: true, total: questions.length, sessionId });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /api/session?s=ID — Sesión completa con preguntas y mensajes ──
        if (path === "/api/session" && request.method === "GET") {
            if (!isAdmin) return jsonRes({ error: "Unauthorized" }, 403);
            try {
                const sid = url.searchParams.get("s");
                if (!sid) return jsonRes({ error: "Missing session ID" }, 400);

                // Ejecutar las 3 queries en paralelo
                const [sessions, questions, mensajes] = await Promise.all([
                    supa(env, "sessions?id=eq." + sid),
                    supa(env, "questions?session_id=eq." + sid + "&order=idx.asc"),
                    supa(env, "mensajes?session_id=eq." + sid + "&order=created_at.asc")
                ]);

                if (!sessions || sessions.length === 0) return jsonRes({ error: "Session not found" }, 404);
                const sess = sessions[0];

                const questionsFormatted = (questions || []).map(q => ({
                    index: q.idx,
                    htmlRaw: q.html_raw,
                    respuesta: q.respuesta,
                    justificacion: q.justificacion,
                    accionDinamica: q.accion_dinamica,
                    mensajes: (mensajes || [])
                        .filter(m => m.question_idx === q.idx)
                        .map(m => ({ from: m.from_user, text: m.msg_text, time: m.created_at }))
                }));

                return jsonRes({
                    id: sess.id,
                    nombre: sess.nombre,
                    nombreCompleto: sess.nombre_completo,
                    pageHTML: sess.page_html,
                    createdAt: sess.created_at,
                    questions: questionsFormatted
                });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── POST /api/answer — Actualizar respuesta/justificación/mensaje ──
        if (path === "/api/answer" && request.method === "POST") {
            try {
                const body = await request.json();
                const sid = body.sessionId;
                const idx = body.questionIndex;
                if (!sid) return jsonRes({ error: "Missing sessionId" }, 400);

                // Actualizar campos de la pregunta (atómico, sin race conditions)
                const updateFields = {};
                if (body.letra !== undefined) updateFields.respuesta = body.letra;
                if (body.justificacion !== undefined) updateFields.justificacion = body.justificacion;
                if (body.accionDinamica !== undefined) {
                    updateFields.accion_dinamica = body.accionDinamica;
                    updateFields.respuesta = "done";
                }

                const promises = [];

                if (Object.keys(updateFields).length > 0) {
                    promises.push(supa(env, "questions?session_id=eq." + sid + "&idx=eq." + idx, {
                        method: "PATCH",
                        headers: { "Prefer": "return=minimal" },
                        body: updateFields
                    }));
                }

                // Insertar mensaje si viene
                if (body.mensaje) {
                    promises.push(supa(env, "mensajes", {
                        method: "POST",
                        headers: { "Prefer": "return=minimal" },
                        body: {
                            session_id: sid,
                            question_idx: idx,
                            from_user: body.mensaje.from,
                            msg_text: body.mensaje.text
                        }
                    }));
                }

                if (promises.length > 0) await Promise.all(promises);

                return jsonRes({ ok: true });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /api/answers?s=ID ──
        if (path === "/api/answers" && request.method === "GET") {
            try {
                const sid = url.searchParams.get("s");
                if (!sid) return jsonRes({ error: "Missing session ID" }, 400);

                const [questions, mensajes, sessions] = await Promise.all([
                    supa(env, "questions?session_id=eq." + sid + "&order=idx.asc"),
                    supa(env, "mensajes?session_id=eq." + sid + "&order=created_at.asc"),
                    supa(env, "sessions?id=eq." + sid + "&select=created_at")
                ]);

                if (!questions || questions.length === 0) return jsonRes({ error: "Session not found" }, 404);

                return jsonRes({
                    answers: questions.map(q => q.respuesta),
                    justificaciones: questions.map(q => q.justificacion || ""),
                    mensajes: questions.map(q =>
                        (mensajes || [])
                            .filter(m => m.question_idx === q.idx)
                            .map(m => ({ from: m.from_user, text: m.msg_text, time: m.created_at }))
                    ),
                    accionesDinamicas: questions.map(q => q.accion_dinamica || null),
                    createdAt: sessions?.[0]?.created_at
                });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /api/status?s=ID ──
        if (path === "/api/status" && request.method === "GET") {
            if (!isAdmin) return jsonRes({ active: false });
            try {
                const sid = url.searchParams.get("s");
                if (!sid) return jsonRes({ active: false });

                const [sessions, questions] = await Promise.all([
                    supa(env, "sessions?id=eq." + sid),
                    supa(env, "questions?session_id=eq." + sid + "&select=respuesta")
                ]);

                if (!sessions || sessions.length === 0) return jsonRes({ active: false });
                const sess = sessions[0];

                return jsonRes({
                    active: true,
                    createdAt: sess.created_at,
                    nombre: sess.nombre || sess.id,
                    nombreCompleto: sess.nombre_completo || "",
                    total: (questions || []).length,
                    answered: (questions || []).filter(q => q.respuesta).length
                });
            } catch (e) {
                return jsonRes({ active: false });
            }
        }

        // ── GET /api/sessions — Lista de sesiones con conteo de respuestas ──
        if (path === "/api/sessions" && request.method === "GET") {
            if (!isAdmin) return jsonRes({ error: "Unauthorized" }, 403);
            try {
                // PostgREST embedding: trae sesiones con sus preguntas (solo respuesta)
                const sessions = await supa(env,
                    "sessions?select=id,nombre,nombre_completo,created_at,questions(respuesta)&order=created_at.desc&limit=30"
                );

                const result = (sessions || []).map(s => ({
                    id: s.id,
                    nombre: s.nombre || s.id,
                    nombreCompleto: s.nombre_completo || "",
                    createdAt: s.created_at,
                    total: (s.questions || []).length,
                    answered: (s.questions || []).filter(q => q.respuesta).length
                }));

                return jsonRes({ sessions: result });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /helper — Sirve helper.html con credenciales Supabase inyectadas ──
        if (path === "/helper") {
            if (!isAdmin) return new Response("Unauthorized", { status: 403, headers: CORS });
            let html = await fetchGitHub("helper.html");
            if (!html) return new Response("Error cargando helper.html", { status: 500, headers: CORS });
            html = html.replace('"DEPLOY_SUPABASE_URL"', '"' + (env.SUPABASE_URL || '') + '"');
            html = html.replace('"DEPLOY_SUPABASE_ANON_KEY"', '"' + (env.SUPABASE_ANON_KEY || '') + '"');
            html = html.replace('"DEPLOY_ADMIN_TOKEN"', '"' + (env.ADMIN_TOKEN || '') + '"');
            return new Response(html, {
                headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS }
            });
        }

        // ── GET / — client_friend.js con credenciales inyectadas ──
        const script = await fetchGitHub("client_friend.js");
        if (!script) return new Response("Error cargando client_friend.js", { status: 500, headers: CORS });
        let processed = script.replace('"DEPLOY_WORKER_URL"', '"' + url.origin + '"');
        processed = processed.replace('"DEPLOY_SUPABASE_URL"', '"' + (env.SUPABASE_URL || '') + '"');
        processed = processed.replace('"DEPLOY_SUPABASE_ANON_KEY"', '"' + (env.SUPABASE_ANON_KEY || '') + '"');
        return new Response(processed, {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", ...CORS }
        });
    }
};
