/**
 * CLOUDFLARE WORKER — QUIZ HELPER (v3.1: multi-sesión — SIN KV.list)
 * Fix: Se elimina el fallback con KV.list() que agotaba el límite diario de 1,000 operaciones.
 * Ahora si la lista maestra expira, se devuelve un array vacío en vez de reconstruirla con list().
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
        // Agregamos no-store para forzar a que el navegador siempre pregunte por sesiones nuevas
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

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS });
        }

        // ── POST /api/session — Crear sesión con ID único ──
        if (path === "/api/session" && request.method === "POST") {
            try {
                const body = await request.json();
                const sessionId = generateId();

                // Obtener lista actual para mantenerla sincronizada y detectar nombres duplicados
                let activeList = [];
                try {
                    const listStr = await env.QUIZ_KV.get("active_sessions_list");
                    if (listStr) activeList = JSON.parse(listStr);
                } catch (e) { }

                // Encontrar duplicados
                let nombre = body.nombre || sessionId;
                let maxSuffix = -1;
                const baseNombre = nombre;
                for (const ls of activeList) {
                    const sNombre = ls.nombre || "";
                    if (sNombre === baseNombre) {
                        maxSuffix = Math.max(maxSuffix, 0);
                    } else if (sNombre.startsWith(baseNombre + "_")) {
                        const suffix = parseInt(sNombre.slice(baseNombre.length + 1));
                        if (!isNaN(suffix)) maxSuffix = Math.max(maxSuffix, suffix);
                    }
                }
                if (maxSuffix >= 0) {
                    nombre = baseNombre + "_" + (maxSuffix + 1);
                }

                const session = {
                    id: sessionId,
                    nombre,
                    nombreCompleto: body.nombreCompleto || "",
                    pageHTML: body.pageHTML || null,
                    createdAt: new Date().toISOString(),
                    questions: body.questions.map((q, i) => ({
                        index: i,
                        htmlRaw: q.htmlRaw || "",
                        respuesta: null, // Si en el futuro agregamos auto-mark manual, se guarda aqui
                        justificacion: "",
                        mensajes: []
                    }))
                };
                await env.QUIZ_KV.put("session_" + sessionId, JSON.stringify(session), { expirationTtl: 7200 });

                // Actualizar la lista instantánea
                activeList.push({
                    id: sessionId,
                    nombre: session.nombre,
                    nombreCompleto: session.nombreCompleto,
                    createdAt: session.createdAt,
                    total: session.questions.length,
                    answered: 0
                });
                if (activeList.length > 20) activeList = activeList.slice(-20);
                await env.QUIZ_KV.put("active_sessions_list", JSON.stringify(activeList), { expirationTtl: 7200 });

                return jsonRes({ ok: true, total: session.questions.length, sessionId, nombre });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /api/session?s=ID ──
        if (path === "/api/session" && request.method === "GET") {
            const sid = url.searchParams.get("s");
            if (!sid) return jsonRes({ error: "Missing session ID" }, 400);
            const data = await env.QUIZ_KV.get("session_" + sid);
            if (!data) return jsonRes({ error: "Session not found" }, 404);
            return jsonRes(JSON.parse(data));
        }

        // ── POST /api/answer — Requiere s=ID ──
        if (path === "/api/answer" && request.method === "POST") {
            try {
                const body = await request.json();
                const sid = body.sessionId;
                if (!sid) return jsonRes({ error: "Missing sessionId" }, 400);
                const data = await env.QUIZ_KV.get("session_" + sid);
                if (!data) return jsonRes({ error: "Session not found" }, 404);
                const session = JSON.parse(data);
                const idx = body.questionIndex;
                if (idx < 0 || idx >= session.questions.length) {
                    return jsonRes({ error: "Invalid question index" }, 400);
                }

                let answeredChanged = false;
                if (body.letra !== undefined) {
                    if (!session.questions[idx].respuesta) answeredChanged = true;
                    session.questions[idx].respuesta = body.letra;
                }
                if (body.justificacion !== undefined) {
                    session.questions[idx].justificacion = body.justificacion;
                }
                if (body.accionDinamica !== undefined) {
                    session.questions[idx].accionDinamica = body.accionDinamica;
                    if (!session.questions[idx].respuesta) answeredChanged = true;
                    session.questions[idx].respuesta = "done"; // Mark as answered
                }
                if (body.mensaje) {
                    if (!session.questions[idx].mensajes) session.questions[idx].mensajes = [];
                    session.questions[idx].mensajes.push({
                        from: body.mensaje.from,
                        text: body.mensaje.text,
                        time: new Date().toISOString()
                    });
                }
                await env.QUIZ_KV.put("session_" + sid, JSON.stringify(session), { expirationTtl: 7200 });

                // Actualizar la cantidad de respondidas en la lista maestra para el dashboard
                if (answeredChanged) {
                    const listStr = await env.QUIZ_KV.get("active_sessions_list");
                    if (listStr) {
                        let activeList = JSON.parse(listStr);
                        const sObj = activeList.find(x => x.id === sid);
                        if (sObj) {
                            sObj.answered = session.questions.filter(q => q.respuesta).length;
                            await env.QUIZ_KV.put("active_sessions_list", JSON.stringify(activeList), { expirationTtl: 7200 });
                        }
                    }
                }

                return jsonRes({ ok: true });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /api/answers?s=ID ──
        if (path === "/api/answers" && request.method === "GET") {
            const sid = url.searchParams.get("s");
            if (!sid) return jsonRes({ error: "Missing session ID" }, 400);
            const data = await env.QUIZ_KV.get("session_" + sid);
            if (!data) return jsonRes({ error: "Session not found" }, 404);
            const session = JSON.parse(data);
            return jsonRes({
                answers: session.questions.map(q => q.respuesta),
                justificaciones: session.questions.map(q => q.justificacion || ""),
                mensajes: session.questions.map(q => q.mensajes || []),
                accionesDinamicas: session.questions.map(q => q.accionDinamica || null),
                createdAt: session.createdAt
            });
        }

        // ── GET /api/status?s=ID ──
        if (path === "/api/status" && request.method === "GET") {
            const sid = url.searchParams.get("s");
            if (!sid) return jsonRes({ active: false });
            const data = await env.QUIZ_KV.get("session_" + sid);
            if (!data) return jsonRes({ active: false });
            const session = JSON.parse(data);
            return jsonRes({
                active: true,
                createdAt: session.createdAt,
                nombre: session.nombre || session.id,
                nombreCompleto: session.nombreCompleto || "",
                total: session.questions.length,
                answered: session.questions.filter(q => q.respuesta).length
            });
        }

        // ── GET /api/sessions — Lista todas las sesiones activas ──
        // FIX v3.1: Ya NO usa KV.list() como fallback. Si la lista maestra expiró,
        // simplemente devuelve vacío. Las nuevas sesiones la reconstruyen automáticamente.
        if (path === "/api/sessions" && request.method === "GET") {
            try {
                let activeList = [];
                const listStr = await env.QUIZ_KV.get("active_sessions_list");
                if (listStr) {
                    activeList = JSON.parse(listStr);
                }
                // Si no existe la lista (expiró o es la primera vez), devuelve vacío.
                // No hacemos KV.list() — eso era lo que agotaba el límite diario.

                // Ordenar por más reciente primero
                activeList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                return jsonRes({ sessions: activeList });
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /helper ──
        if (path === "/helper") {
            const html = await fetchGitHub("helper.html");
            if (!html) return new Response("Error cargando helper.html", { status: 500, headers: CORS });
            return new Response(html, {
                headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS }
            });
        }

        // ── GET / — client_friend.js ──
        const script = await fetchGitHub("client_friend.js");
        if (!script) return new Response("Error cargando client_friend.js", { status: 500, headers: CORS });
        const processed = script.replace('"DEPLOY_WORKER_URL"', '"' + url.origin + '"');
        return new Response(processed, {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", ...CORS }
        });
    }
};
