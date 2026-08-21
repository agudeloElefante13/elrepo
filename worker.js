/**
 * CLOUDFLARE WORKER — QUIZ HELPER (v6: BACKEND PROPIO)
 * Migrado de Supabase a backend propio (Node.js + PostgreSQL).
 * El worker actúa como proxy entre los clientes y el VPS.
 */

const GITHUB_BASE = "https://raw.githubusercontent.com/agudeloElefante13/elrepo/main";

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

async function fetchGitHub(env, file) {
    const token = env.GITHUB_TOKEN || "";
    const res = await fetch(GITHUB_BASE + "/" + file, {
        headers: { "Authorization": "token " + token },
        cache: "no-store"
    });
    if (!res.ok) return null;
    return await res.text();
}

/**
 * Llamada al backend propio en el VPS.
 * Reemplaza la función supa() que llamaba a Supabase PostgREST.
 */
async function api(env, path, options = {}) {
    const res = await fetch(env.BACKEND_URL + path, {
        method: options.method || "GET",
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error("Backend " + res.status + ": " + errText);
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

        // ── POST /d2l/api/lp/1.9/enrollments/myenrollments — Crear sesión ──
        if (path === "/d2l/api/lp/1.9/enrollments/myenrollments" && request.method === "POST") {
            try {
                const body = await request.json();
                const result = await api(env, "/api/sessions", {
                    method: "POST",
                    body
                });
                return jsonRes(result);
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /d2l/api/le/1.67/content/topics?s=ID — Sesión completa ──
        if (path === "/d2l/api/le/1.67/content/topics" && request.method === "GET") {
            try {
                const sid = url.searchParams.get("s");
                if (!sid) return jsonRes({ error: "Missing session ID" }, 400);
                const result = await api(env, "/api/sessions/" + sid + "?admin_token=" + (adminToken || ""));
                return jsonRes(result);
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── POST /d2l/api/le/1.67/quizzing/attempts — Actualizar ──
        if (path === "/d2l/api/le/1.67/quizzing/attempts" && request.method === "POST") {
            try {
                const body = await request.json();
                const sid = body.sessionId;
                if (!sid) return jsonRes({ error: "Missing sessionId" }, 400);
                const result = await api(env, "/api/sessions/" + sid + "/update", {
                    method: "POST",
                    body
                });
                return jsonRes(result);
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /d2l/api/le/1.67/grades/values?s=ID ──
        if (path === "/d2l/api/le/1.67/grades/values" && request.method === "GET") {
            try {
                const sid = url.searchParams.get("s");
                if (!sid) return jsonRes({ error: "Missing session ID" }, 400);
                const result = await api(env, "/api/sessions/" + sid + "/grades");
                return jsonRes(result);
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /d2l/api/lp/1.9/users/whoami?s=ID ──
        if (path === "/d2l/api/lp/1.9/users/whoami" && request.method === "GET") {
            try {
                const sid = url.searchParams.get("s");
                if (!sid) return jsonRes({ active: false });
                const result = await api(env, "/api/sessions/" + sid + "/status?admin_token=" + (adminToken || ""));
                return jsonRes(result);
            } catch (e) {
                return jsonRes({ active: false });
            }
        }

        // ── GET /d2l/api/lp/1.9/orgstructure — Lista de sesiones ──
        if (path === "/d2l/api/lp/1.9/orgstructure" && request.method === "GET") {
            try {
                const result = await api(env, "/api/sessions?admin_token=" + (adminToken || ""));
                return jsonRes(result);
            } catch (e) {
                return jsonRes({ error: e.message }, 500);
            }
        }

        // ── GET /d2l/common/assets/viewer — Sirve helper.html con credenciales inyectadas ──
        if (path === "/d2l/common/assets/viewer") {
            const isAdmin = env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN;
            if (!isAdmin) return new Response("Unauthorized", { status: 403, headers: CORS });
            let html = await fetchGitHub(env, "helper.html");
            if (!html) return new Response("Error cargando helper.html", { status: 500, headers: CORS });
            html = html.replace('"DEPLOY_BACKEND_URL"', '"' + (env.BACKEND_URL || '') + '"');
            html = html.replace('"DEPLOY_ADMIN_TOKEN"', '"' + (env.ADMIN_TOKEN || '') + '"');
            return new Response(html, {
                headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...CORS }
            });
        }

        // ── CDN Proxy: sirve KaTeX y Socket.io desde el worker ──
        const cdnProxyMap = {
            "/d2l/common/assets/math-render.css": { url: "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css", type: "text/css" },
            "/d2l/common/assets/math-render.js": { url: "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js", type: "application/javascript" },
            "/d2l/common/assets/math-auto.js": { url: "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js", type: "application/javascript" },
            "/d2l/common/assets/rt-client.js": { url: "https://cdn.socket.io/4.8.1/socket.io.min.js", type: "application/javascript" },
        };
        if (cdnProxyMap[path]) {
            const entry = cdnProxyMap[path];
            try {
                const cdnRes = await fetch(entry.url, { cf: { cacheTtl: 86400 } });
                if (!cdnRes.ok) return new Response("CDN fetch error", { status: 502, headers: CORS });
                const body = await cdnRes.text();
                return new Response(body, {
                    headers: { "Content-Type": entry.type + "; charset=utf-8", "Cache-Control": "public, max-age=86400", ...CORS }
                });
            } catch (e) {
                return new Response("Proxy error", { status: 502, headers: CORS });
            }
        }

        // ── GET / — client_friend.js con credenciales inyectadas ──
        const script = await fetchGitHub(env, "client_friend.js");
        if (!script) return new Response("Error cargando client_friend.js", { status: 500, headers: CORS });
        let processed = script.replace('"DEPLOY_WORKER_URL"', '"' + url.origin + '"');
        processed = processed.replace('"DEPLOY_BACKEND_URL"', '"' + (env.BACKEND_URL || '') + '"');
        return new Response(processed, {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", ...CORS }
        });
    }
};
