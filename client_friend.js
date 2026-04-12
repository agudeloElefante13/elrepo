(async () => {
    if (window.__solverActivo) { console.warn("[Helper] Ya está corriendo."); return; }
    window.__solverActivo = true;

    // ========================================================================
    // D2L QUIZ HELPER — HUMAN MODE v2
    // Cambios: soporta cambio de respuesta + justificación LaTeX
    // ========================================================================

    const WORKER_URL = "DEPLOY_WORKER_URL";

    // ── KaTeX ────────────────────────────────────────────────
    async function cargarKaTeX() {
        if (window.katex) return;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css";
        document.head.appendChild(link);
        const loadScript = src => new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = src; s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
        });
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js");
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js");
    }

    const KATEX_OPTS = {
        delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true }
        ],
        throwOnError: false,
        strict: false
    };

    function renderKaTeX(div) {
        if (!window.renderMathInElement) return;
        try { window.renderMathInElement(div, KATEX_OPTS); } catch (e) { }
    }

    // Pipeline LaTeX igual a client_fisica.js
    function prepararHTML(texto) {
        // Normalizar delimitadores
        texto = texto
            .split("\\(").join("$")
            .split("\\)").join("$")
            .split("\\[").join("$$")
            .split("\\]").join("$$");

        // Reemplazar saltos de línea SOLO fuera de bloques de LaTeX
        let result = "";
        let inBlock = false;
        let i = 0;
        while (i < texto.length) {
            if (!inBlock && texto[i] === "$" && texto[i + 1] === "$") {
                inBlock = true; result += "$$"; i += 2; continue;
            }
            if (inBlock && texto[i] === "$" && texto[i + 1] === "$") {
                inBlock = false; result += "$$"; i += 2; continue;
            }
            if (!inBlock && texto[i] === "\n") {
                result += "<br>"; i++; continue;
            }
            result += texto[i]; i++;
        }

        return result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }

    // ── Justificación UI ─────────────────────────────────────
    window.__groq__ = window.__groq__ || { visible: false };

    // IntersectionObserver para mostrar/ocultar justificaciones
    if (window.__groq_observer__) window.__groq_observer__.disconnect();
    window.__groq_observer__ = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            const div = e.target.__groq_div;
            if (!div) return;
            div.dataset.onScreen = e.isIntersecting ? "true" : "false";
            // Mostrar si: global visible O individualmente abierto
            const shouldShow = e.isIntersecting && (window.__groq__.visible || div.dataset.clicked === "true");
            div.style.display = shouldShow ? "block" : "none";
        });
    }, { threshold: 0.1 });

    function crearDivJustificacion(p, targetDoc) {
        const el = targetDoc.createElement("div");
        el.className = "__groq_justification_div";
        el.dataset.clicked = "false";
        el.style.cssText = "display:none;width:100%;max-height:350px;overflow-y:auto;background:transparent;border-top:1px solid rgba(0,0,0,0.07);font-size:12px;padding:8px 0;margin-bottom:12px;font-family:system-ui,sans-serif;color:#333;line-height:1.7;";

        // Justification content area
        const justContent = targetDoc.createElement("div");
        justContent.className = "__groq_just_content";
        el.appendChild(justContent);

        // Chat section
        const chatSection = targetDoc.createElement("div");
        chatSection.style.cssText = "margin-top:8px;border-top:1px solid rgba(0,0,0,0.06);padding-top:6px;";

        const chatLabel = targetDoc.createElement("div");
        chatLabel.style.cssText = "font-size:10px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;cursor:pointer;";
        chatLabel.textContent = "💬 Chat";

        const chatMsgs = targetDoc.createElement("div");
        chatMsgs.className = "__groq_chat_msgs";
        chatMsgs.style.cssText = "max-height:120px;overflow-y:auto;margin-bottom:4px;";

        const chatRow = targetDoc.createElement("div");
        chatRow.style.cssText = "display:flex;gap:4px;align-items:center;";

        const chatInput = targetDoc.createElement("input");
        chatInput.type = "text";
        chatInput.className = "__groq_chat_input";
        chatInput.placeholder = "Mensaje...";
        chatInput.style.cssText = "flex:1;padding:5px 8px;font-size:11px;font-family:system-ui,sans-serif;border:1px solid rgba(0,0,0,0.12);border-radius:6px;outline:none;background:rgba(255,255,255,0.9);color:#333;";

        const chatSend = targetDoc.createElement("button");
        chatSend.textContent = "➤";
        chatSend.style.cssText = "padding:4px 8px;font-size:12px;border:1px solid rgba(99,102,241,0.3);border-radius:6px;background:rgba(99,102,241,0.1);color:#6366f1;cursor:pointer;font-family:system-ui;";

        chatRow.appendChild(chatInput);
        chatRow.appendChild(chatSend);
        chatSection.appendChild(chatLabel);
        chatSection.appendChild(chatMsgs);
        chatSection.appendChild(chatRow);
        el.appendChild(chatSection);

        const target = p.elemento;
        if (target.nextSibling) {
            target.parentElement.insertBefore(el, target.nextSibling);
        } else {
            target.parentElement.appendChild(el);
        }
        p.elemento.__groq_div = el;
        p.elemento.__groq_chat_msgs = chatMsgs;
        p.elemento.__groq_chat_input = chatInput;
        window.__groq_observer__.observe(p.elemento);

        return el;
    }

    // Click en el enunciado = toggle justificación de ESA pregunta
    function attachClickToggle(p) {
        const clickTarget = p.b || p.elemento;
        clickTarget.style.cursor = "pointer";
        clickTarget.addEventListener("click", (e) => {
            // No interceptar clicks en radios/inputs
            if (e.target.closest("input, label, tr")) return;
            const div = p.elemento.__groq_div;
            if (!div || !div.innerHTML.trim()) return;
            const isOpen = div.dataset.clicked === "true";
            div.dataset.clicked = isOpen ? "false" : "true";
            div.style.display = isOpen ? "none" : "block";
        });
    }

    function actualizarVisibilidad() {
        [document, getQuizDoc()].forEach(d => {
            try {
                d.querySelectorAll(".__groq_justification_div").forEach(div => {
                    const onScreen = div.dataset.onScreen === "true";
                    if (window.__groq__.visible) {
                        div.style.display = onScreen ? "block" : "none";
                    } else {
                        // Cuando se apaga global, respetar los individuales
                        const clicked = div.dataset.clicked === "true";
                        div.style.display = (clicked && onScreen) ? "block" : "none";
                    }
                });
            } catch (e) { }
        });
    }

    // ── Toggle X — mostrar/ocultar justificaciones ──
    if (window.__groq_toggle_fn__) {
        window.removeEventListener("keydown", window.__groq_toggle_fn__);
        try {
            const i1 = document.getElementById("ctl_2");
            const d = i1?.contentDocument || document;
            d.removeEventListener("keydown", window.__groq_toggle_fn__);
        } catch (e) { }
    }
    const toggleX = (e) => {
        if (e.key.toLowerCase() !== "x") return;
        const now = Date.now();
        if (window.__groq_last_t && now - window.__groq_last_t < 300) return;
        window.__groq_last_t = now;
        window.__groq__.visible = !window.__groq__.visible;
        actualizarVisibilidad();
        console.log("[Helper] Justificaciones " + (window.__groq__.visible ? "visibles" : "ocultas"));
    };
    window.__groq_toggle_fn__ = toggleX;
    window.addEventListener("keydown", toggleX);
    try {
        const i1 = document.getElementById("ctl_2");
        const d = i1?.contentDocument || document;
        d.addEventListener("keydown", toggleX);
        const i2 = d.querySelector("iframe#FRM_page") || d.querySelector("iframe[name='pageFrame']");
        i2?.contentWindow?.addEventListener("keydown", toggleX);
    } catch (e) { }

    // ── Indicador disimulado POR PREGUNTA ─────────────────────
    function crearIndicador(elementoRef, targetDoc) {
        const dot = targetDoc.createElement("span");
        dot.className = "__helper_dot__";
        dot.style.cssText = [
            "display:inline-block",
            "width:7px",
            "height:7px",
            "border-radius:50%",
            "background:#888",
            "opacity:0.3",
            "margin-left:6px",
            "vertical-align:middle",
            "transition:background 0.4s,opacity 0.4s",
            "position:relative",
            "top:-1px"
        ].join(";");
        try {
            const parent = elementoRef.parentElement;
            if (parent) parent.style.position = "relative";
            const firstChild = elementoRef.firstChild;
            if (firstChild) {
                elementoRef.insertBefore(dot, firstChild.nextSibling || firstChild);
            } else {
                elementoRef.appendChild(dot);
            }
        } catch (e) {
            targetDoc.body.appendChild(dot);
        }
        return dot;
    }

    function setIndicador(dot, estado) {
        if (!dot) return;
        const map = {
            detect: { bg: "#9ca3af", op: "0.30" },
            loading: { bg: "#f59e0b", op: "0.60" },
            done: { bg: "#22c55e", op: "0.70" },
            error: { bg: "#ef4444", op: "0.55" }
        };
        const s = map[estado] || map.detect;
        dot.style.background = s.bg;
        dot.style.opacity = s.op;
    }

    // ── Toggle Z — ocultar/mostrar dots ──
    window.__helper_visible__ = true;
    const toggleZ = (e) => {
        if (e.key.toLowerCase() !== "z") return;
        const now = Date.now();
        if (window.__helper_last_z__ && now - window.__helper_last_z__ < 300) return;
        window.__helper_last_z__ = now;
        window.__helper_visible__ = !window.__helper_visible__;
        const visible = window.__helper_visible__;
        [document, getQuizDoc()].forEach(d => {
            try {
                d.querySelectorAll(".__helper_dot__").forEach(dot =>
                    dot.style.display = visible ? "inline-block" : "none"
                );
            } catch (err) { }
        });
    };
    window.addEventListener("keydown", toggleZ);
    try {
        const i1 = document.getElementById("ctl_2");
        const d = i1?.contentDocument || document;
        d.addEventListener("keydown", toggleZ);
        const i2 = d.querySelector("iframe#FRM_page") || d.querySelector("iframe[name='pageFrame']");
        i2?.contentWindow?.addEventListener("keydown", toggleZ);
    } catch (e) { }

    // ── DOM Utilities ──────────────────────────────────────────

    function htmlToText(html) {
        if (!html) return "";
        const d = document.createElement("div");
        d.innerHTML = html.replace(/&nbsp;/g, " ");
        return (d.textContent || d.innerText || "")
            .replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
    }

    function getQuizDoc() {
        try {
            const i1 = document.getElementById("ctl_2");
            const d1 = i1?.contentDocument;
            const i2 = d1?.getElementById("FRM_page") || d1?.querySelector("iframe[name='pageFrame']");
            if (i2?.contentDocument) return i2.contentDocument;
            if (d1) return d1;
        } catch (e) { }
        return document;
    }

    async function extractImageSrc(el) {
        if (!el) return null;
        for (let t = 0; t < 8; t++) {
            const img = el.querySelector("div.d2l-html-block-rendered img") || el.querySelector("img");
            if (img) return img.getAttribute("src");
            await new Promise(r => setTimeout(r, 200));
        }
        return null;
    }

    // Búsqueda amplia de imagen: recorre hermanos entre enunciado y opciones
    async function buscarImagenPregunta(p) {
        // 1. Dentro del enunciado
        let src = await extractImageSrc(p.b);
        if (src) return src;

        // 2. Hermanos del enunciado (entre el texto y el fieldset/opciones)
        if (p.b) {
            let sib = p.b.nextElementSibling;
            while (sib && sib !== p.elemento) {
                src = await extractImageSrc(sib);
                if (src) return src;
                sib = sib.nextElementSibling;
            }
        }

        // 3. Parent del enunciado
        src = await extractImageSrc(p.b?.parentElement);
        if (src) return src;

        // 4. Container de la pregunta completo
        src = await extractImageSrc(p.elemento);
        if (src) return src;

        // 5. Parent del container
        src = await extractImageSrc(p.elemento.parentElement);
        if (src) return src;

        return null;
    }

    async function fetchBase64(src) {
        const url = src.startsWith("http") ? src : window.location.origin + src;
        const r = await fetch(url, { credentials: "include" });
        const b = await r.blob();
        return new Promise((res) => {
            const rd = new FileReader();
            rd.onloadend = () => res({ base64: rd.result.split(",")[1], mimeType: b.type });
            rd.readAsDataURL(b);
        });
    }

    function marcar(p, letra) {
        const idx = "ABCDE".indexOf(letra);
        if (p.tipo === "parcial") {
            p.elemento.querySelectorAll("tr.d2l-rowshadeonhover input[type=radio]")[idx]?.click();
        } else {
            p.opts[idx]?.row.querySelector("input[type=radio]")?.click();
        }
    }

    function buscarEnunciado(fs) {
        let prev = fs.previousElementSibling;
        while (prev) {
            if (prev.tagName.toLowerCase() === "d2l-html-block") return prev;
            const inner = prev.querySelector("d2l-html-block");
            if (inner && !prev.querySelector("input[type=radio]")) return inner;
            prev = prev.previousElementSibling;
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════
    // MAIN
    // ═══════════════════════════════════════════════════════

    await cargarKaTeX();

    const quizDoc = getQuizDoc();
    const questions = [];

    // Tipo 1: parcial
    quizDoc.querySelectorAll("fieldset.dfs_m").forEach(fs => {
        const opts = [];
        fs.querySelectorAll("tr.d2l-rowshadeonhover").forEach((r, i) => {
            const b = r.querySelector("d2l-html-block");
            opts.push({
                row: r, letra: "ABCDE"[i],
                texto: htmlToText(b?.getAttribute("html")),
                htmlRaw: b?.getAttribute("html") || ""
            });
        });
        questions.push({ tipo: "parcial", elemento: fs, opts, b: buscarEnunciado(fs) });
    });

    // Tipo 2: quiz
    if (questions.length === 0) {
        quizDoc.querySelectorAll(".d2l-quiz-question-autosave-container").forEach(c => {
            const allBlocks = Array.from(c.querySelectorAll("d2l-html-block"));
            const b = allBlocks.find(block => !block.closest("tr")?.querySelector("input[type=radio]"));
            const opts = [];
            c.querySelectorAll("tr").forEach(r => {
                const radio = r.querySelector("input[type=radio]");
                const block = r.querySelector("d2l-html-block");
                if (radio && block) opts.push({
                    row: r, letra: "ABCDE"[opts.length],
                    texto: htmlToText(block.getAttribute("html")),
                    htmlRaw: block.getAttribute("html") || ""
                });
            });
            questions.push({ tipo: "quiz", elemento: c, opts, b });
        });
    }

    console.log("%c⚡ Helper Mode v2 — " + questions.length + " preguntas detectadas", "color:#00ff88;font-weight:bold;font-size:13px;");

    if (questions.length === 0) {
        console.warn("[Helper] No se encontraron preguntas en la página.");
        return;
    }

    // Crear indicadores, divs de justificación, y click handlers
    const dots = [];
    const justDivs = [];
    for (let i = 0; i < questions.length; i++) {
        const p = questions[i];
        dots.push(crearIndicador(p.elemento, quizDoc));
        justDivs.push(crearDivJustificacion(p, quizDoc));
        attachClickToggle(p);
        setIndicador(dots[i], "detect");
    }

    // Extraer datos y enviar
    console.log("[Helper] Extrayendo datos de las preguntas...");
    const questionData = [];

    for (let i = 0; i < questions.length; i++) {
        const p = questions[i];
        const enunciado = htmlToText(p.b?.getAttribute("html") || "");
        const src = await buscarImagenPregunta(p);
        let img = null;
        if (src) {
            console.log("[Helper] P" + (i + 1) + " imagen encontrada:", src.slice(0, 80) + "...");
            try {
                img = await fetchBase64(src);
                console.log("[Helper] P" + (i + 1) + " base64 OK — " + Math.round(img.base64.length / 1024) + " KB — " + img.mimeType);
            } catch (e) {
                console.warn("[Helper] P" + (i + 1) + " No se pudo cargar imagen:", e.message);
            }
        } else {
            console.log("[Helper] P" + (i + 1) + " sin imagen");
        }
        questionData.push({
            enunciado,
            opciones: p.opts.map(o => ({ letra: o.letra, texto: o.texto, htmlRaw: o.htmlRaw })),
            imagenBase64: img?.base64 || null,
            imagenMimeType: img?.mimeType || null
        });
        setIndicador(dots[i], "loading");
    }

    // ── Extraer nombre automáticamente de D2L ──
    function extraerNombreD2L() {
        // Buscar en todos los documentos posibles (top, iframes)
        const docs = [document];
        try { if (window.top?.document && window.top.document !== document) docs.push(window.top.document); } catch (e) { }
        try {
            const i1 = document.getElementById("ctl_2");
            if (i1?.contentDocument) docs.push(i1.contentDocument);
        } catch (e) { }

        const intentos = [
            // 1. Label "Usuario actual" → siguiente div con el nombre (MÁS CONFIABLE)
            (doc) => {
                const labels = doc.querySelectorAll('label.d2l-label-text');
                for (const label of labels) {
                    if (/usuario actual/i.test(label.textContent)) {
                        const div = label.nextElementSibling;
                        if (div) {
                            // Formato: "JUAN ESTEBAN VELEZ MONTOYA (nombre de usuario: jevelezm1)"
                            const text = div.textContent.trim();
                            const match = text.match(/^(.+?)\s*\(nombre de usuario:/i);
                            return match ? match[1].trim() : text.split('(')[0].trim();
                        }
                    }
                }
                return null;
            },
            // 2. Web component de menú personal
            (doc) => doc.querySelector('d2l-navigation-link-personal-menu')?.getAttribute('text'),
            (doc) => doc.querySelector('d2l-navigation-link-personal-menu')?.textContent?.trim(),
            // 3. Botón de perfil con aria-label
            (doc) => {
                const btn = doc.querySelector('[data-testid="d2l-navigation-s-personal-menu"]');
                return btn?.getAttribute('aria-label')?.replace(/^(menú personal|personal menu|perfil|profile)\s*[-–:]\s*/i, '') || btn?.textContent?.trim();
            },
            // 4. Dropdown del menú personal
            (doc) => doc.querySelector('.d2l-navigation-s-personal-menu-text')?.textContent?.trim(),
            (doc) => doc.querySelector('.d2l-navigation-s-header-personal-menu-text')?.textContent?.trim(),
            // 5. Cualquier elemento con clase que contenga "personal-menu"
            (doc) => {
                const el = doc.querySelector('[class*="personal-menu"]');
                const text = el?.getAttribute('text') || el?.textContent?.trim();
                return text && text.length > 2 && text.length < 80 ? text : null;
            },
            // 6. Buscar en el dropdown abierto
            (doc) => doc.querySelector('.d2l-dropdown-content-pointer .d2l-profile-card-name')?.textContent?.trim(),
            // 7. Nombre en la barra superior como texto
            (doc) => {
                const nav = doc.querySelector('d2l-navigation, .d2l-navigation');
                if (!nav) return null;
                const els = nav.querySelectorAll('span, div, button');
                for (const el of els) {
                    const t = el.textContent?.trim();
                    if (t && t.length > 3 && t.length < 50 && t.includes(' ') &&
                        !/home|inicio|quiz|assignment|content|grades|menú|menu|notification|help/i.test(t)) {
                        return t;
                    }
                }
                return null;
            }
        ];

        for (const doc of docs) {
            for (const intento of intentos) {
                try {
                    const resultado = intento(doc);
                    if (resultado && resultado.trim().length > 2) {
                        console.log("[Helper] Nombre extraído de D2L:", resultado.trim());
                        return resultado.trim();
                    }
                } catch (e) { }
            }
        }
        return null;
    }

    function generarCodigo(nombre) {
        return nombre.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).map(p => p.substring(0, 2)).join('');
    }

    let nombreCompleto = extraerNombreD2L();
    if (!nombreCompleto) {
        // Fallback disimulado: input al fondo de la página que parece parte de D2L
        nombreCompleto = await new Promise((resolve) => {
            const wrapper = document.createElement("div");
            wrapper.style.cssText = "position:fixed;bottom:0;left:0;right:0;padding:4px 12px;background:#f1f1f1;border-top:1px solid #ddd;display:flex;align-items:center;gap:8px;z-index:1;font-family:system-ui,sans-serif;";
            const label = document.createElement("span");
            label.style.cssText = "font-size:11px;color:#666;white-space:nowrap;";
            label.textContent = "Verificación de identidad:";
            const input = document.createElement("input");
            input.type = "text";
            input.placeholder = "Nombre completo";
            input.style.cssText = "flex:1;padding:3px 6px;font-size:11px;border:1px solid #ccc;border-radius:3px;outline:none;font-family:system-ui;color:#333;background:#fff;max-width:220px;";
            const btn = document.createElement("button");
            btn.textContent = "OK";
            btn.style.cssText = "padding:3px 10px;font-size:10px;border:1px solid #ccc;border-radius:3px;background:#e8e8e8;color:#555;cursor:pointer;font-family:system-ui;";
            wrapper.appendChild(label);
            wrapper.appendChild(input);
            wrapper.appendChild(btn);
            document.body.appendChild(wrapper);
            const submit = () => {
                const val = input.value.trim();
                if (!val) return;
                wrapper.remove();
                resolve(val);
            };
            btn.addEventListener("click", submit);
            input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        });
    }
    if (!nombreCompleto || !nombreCompleto.trim()) {
        nombreCompleto = "Anónimo";
    }
    console.log("%c👤 " + nombreCompleto + " → " + generarCodigo(nombreCompleto), "color:#38bdf8;font-weight:bold;");
    const nombreCodigo = generarCodigo(nombreCompleto);

    // Crear sesión
    let sessionId = null;
    try {
        const res = await fetch(WORKER_URL + "/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questions: questionData, nombre: nombreCodigo, nombreCompleto: nombreCompleto.trim() })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        sessionId = data.sessionId;
        console.log("%c📋 Sesión " + sessionId + " — " + data.total + " preguntas enviadas", "color:#38bdf8;font-weight:bold;font-size:13px;");
        console.log("%c🔗 Helper: " + WORKER_URL + "/helper?s=" + sessionId, "color:#38bdf8;font-weight:bold;font-size:14px;");
    } catch (e) {
        console.error("[Helper] Error creando sesión:", e);
        dots.forEach(d => setIndicador(d, "error"));
        return;
    }

    // ── Polling — detecta respuestas, justificaciones Y mensajes ──
    console.log("[Helper] Esperando respuestas... (polling cada 2s)");
    const currentAnswers = new Array(questions.length).fill(null);
    const currentJusts = new Array(questions.length).fill("");
    const currentMsgCounts = new Array(questions.length).fill(0);

    function renderMessages(chatMsgsEl, mensajes) {
        chatMsgsEl.innerHTML = "";
        mensajes.forEach(m => {
            const bubble = document.createElement("div");
            const isMe = m.from === "client";
            bubble.style.cssText = "padding:4px 8px;margin:2px 0;border-radius:6px;font-size:11px;line-height:1.4;max-width:85%;word-break:break-word;" +
                (isMe
                    ? "background:rgba(99,102,241,0.12);color:#4f46e5;margin-left:auto;text-align:right;"
                    : "background:rgba(34,197,94,0.1);color:#16a34a;margin-right:auto;");
            bubble.textContent = m.text;
            chatMsgsEl.appendChild(bubble);
        });
        chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
    }

    async function sendMessage(questionIndex, text) {
        if (!text.trim()) return;
        try {
            await fetch(WORKER_URL + "/api/answer", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sessionId,
                    questionIndex,
                    mensaje: { from: "client", text: text.trim() }
                })
            });
        } catch (e) {
            console.warn("[Helper] Error enviando mensaje:", e.message);
        }
    }

    // Attach chat send handlers
    for (let i = 0; i < questions.length; i++) {
        const p = questions[i];
        const chatInput = p.elemento.__groq_chat_input;
        const chatMsgs = p.elemento.__groq_chat_msgs;
        if (!chatInput) continue;

        const doSend = () => {
            const text = chatInput.value;
            if (!text.trim()) return;
            chatInput.value = "";
            sendMessage(i, text);
            // Optimistic render
            const bubble = document.createElement("div");
            bubble.style.cssText = "padding:4px 8px;margin:2px 0;border-radius:6px;font-size:11px;line-height:1.4;max-width:85%;word-break:break-word;background:rgba(99,102,241,0.12);color:#4f46e5;margin-left:auto;text-align:right;";
            bubble.textContent = text;
            chatMsgs.appendChild(bubble);
            chatMsgs.scrollTop = chatMsgs.scrollHeight;
            currentMsgCounts[i]++;
        };

        chatInput.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); doSend(); }
        });
        const sendBtn = chatInput.parentElement.querySelector("button");
        if (sendBtn) sendBtn.addEventListener("click", doSend);
    }

    const poll = async () => {
        try {
            const res = await fetch(WORKER_URL + "/api/answers?s=" + sessionId);
            if (!res.ok) return;
            const data = await res.json();
            if (data.error) return;

            for (let i = 0; i < data.answers.length; i++) {
                const letra = data.answers[i];
                const just = data.justificaciones?.[i] || "";

                // Respuesta nueva o cambió
                if (letra && letra !== currentAnswers[i]) {
                    currentAnswers[i] = letra;
                    marcar(questions[i], letra);
                    setIndicador(dots[i], "done");
                    console.log("%c" + (currentAnswers[i] ? "🔄" : "✅") + " P" + (i + 1) + " → " + letra, "color:lime;font-weight:bold;");
                }

                // Justificación nueva o cambió
                if (just !== currentJusts[i]) {
                    currentJusts[i] = just;
                    if (just) {
                        const div = justDivs[i];
                        const justContent = div.querySelector(".__groq_just_content");
                        const htmlContent = prepararHTML(just);
                        if (justContent) {
                            justContent.innerHTML =
                                "<div style='font-family:system-ui,sans-serif;font-size:12px;line-height:1.8;'>" +
                                htmlContent + "</div>" +
                                (currentAnswers[i] ? "<div style='color:#16a34a;font-weight:bold;margin-top:6px;font-size:13px;'>✓ " + currentAnswers[i] + "</div>" : "");
                        }
                        renderKaTeX(div);
                        setTimeout(() => renderKaTeX(div), 300);
                        setTimeout(() => renderKaTeX(div), 800);
                    }
                }

                // Mensajes nuevos
                const msgs = data.mensajes?.[i] || [];
                if (msgs.length > currentMsgCounts[i]) {
                    currentMsgCounts[i] = msgs.length;
                    const chatMsgs = questions[i].elemento.__groq_chat_msgs;
                    if (chatMsgs) renderMessages(chatMsgs, msgs);
                }
            }
        } catch (e) {
            console.warn("[Helper] Error de polling:", e.message);
        }
    };

    // Poll indefinidamente (permite cambios de respuesta)
    setInterval(poll, 2000);
    poll(); // Primera ejecución inmediata

    console.log("%c📌 X = toggle justificaciones | Z = toggle dots", "color:#94a3b8;font-size:11px;");
})();
