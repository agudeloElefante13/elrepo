(async () => {
    if (window.__solverActivo) { console.warn("[Helper] Ya está corriendo."); return; }
    window.__solverActivo = true;

    // ========================================================================
    // D2L QUIZ HELPER — HUMAN MODE (reemplaza IA por persona)
    // Extrae preguntas → las envía al Worker → espera respuestas del helper
    // ========================================================================

    const WORKER_URL = "DEPLOY_WORKER_URL";

    // —— Indicador disimulado POR PREGUNTA — puntos de color ——
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

    // —— Toggle Z — ocultar/mostrar dots ——
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
        console.log("[Helper] Indicadores " + (visible ? "visibles" : "ocultos"));
    };
    window.addEventListener("keydown", toggleZ);
    try {
        const i1 = document.getElementById("ctl_2");
        const d = i1?.contentDocument || document;
        d.addEventListener("keydown", toggleZ);
        const i2 = d.querySelector("iframe#FRM_page") || d.querySelector("iframe[name='pageFrame']");
        i2?.contentWindow?.addEventListener("keydown", toggleZ);
    } catch (e) { }

    // —— DOM Utilities ——————————————————————————————————

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

    const quizDoc = getQuizDoc();
    const questions = [];

    // Tipo 1: parcial (fieldset.dfs_m)
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

    // Tipo 2: quiz (.d2l-quiz-question-autosave-container)
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

    console.log("%c⚡ Helper Mode — " + questions.length + " preguntas detectadas", "color:#00ff88;font-weight:bold;font-size:13px;");

    if (questions.length === 0) {
        console.warn("[Helper] No se encontraron preguntas en la página.");
        return;
    }

    // —— Crear indicadores ——
    const dots = questions.map(p => {
        const dot = crearIndicador(p.elemento, quizDoc);
        setIndicador(dot, "detect");
        return dot;
    });

    // —— Extraer datos y enviar al Worker ——
    console.log("[Helper] Extrayendo datos de las preguntas...");
    const questionData = [];

    for (let i = 0; i < questions.length; i++) {
        const p = questions[i];
        const enunciado = htmlToText(p.b?.getAttribute("html") || "");
        const src = await extractImageSrc(p.b)
            || await extractImageSrc(p.b?.parentElement)
            || await extractImageSrc(p.elemento.parentElement);
        let img = null;
        if (src) {
            try {
                img = await fetchBase64(src);
            } catch (e) {
                console.warn("[Helper] No se pudo cargar imagen P" + (i + 1));
            }
        }
        questionData.push({
            enunciado,
            opciones: p.opts.map(o => ({ letra: o.letra, texto: o.texto, htmlRaw: o.htmlRaw })),
            imagenBase64: img?.base64 || null,
            imagenMimeType: img?.mimeType || null
        });
        setIndicador(dots[i], "loading");
    }

    // —— Crear sesión en el Worker ——
    try {
        const res = await fetch(WORKER_URL + "/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questions: questionData })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        console.log("%c📋 Sesión creada — " + data.total + " preguntas enviadas", "color:#38bdf8;font-weight:bold;font-size:13px;");
        console.log("%c🔗 Helper: " + WORKER_URL + "/helper", "color:#38bdf8;font-weight:bold;font-size:14px;");
    } catch (e) {
        console.error("[Helper] Error creando sesión:", e);
        dots.forEach(d => setIndicador(d, "error"));
        return;
    }

    // —— Polling — esperar respuestas del helper ——
    console.log("[Helper] Esperando respuestas... (polling cada 2s)");
    const answered = new Set();

    while (answered.size < questions.length) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const res = await fetch(WORKER_URL + "/api/answers");
            if (!res.ok) continue;
            const data = await res.json();
            if (data.error) continue;

            for (let i = 0; i < data.answers.length; i++) {
                if (answered.has(i)) continue;
                const letra = data.answers[i];
                if (letra) {
                    answered.add(i);
                    marcar(questions[i], letra);
                    setIndicador(dots[i], "done");
                    console.log("%c✅ P" + (i + 1) + " → " + letra, "color:lime;font-weight:bold;");
                }
            }
        } catch (e) {
            console.warn("[Helper] Error de polling:", e.message);
        }
    }

    console.log("%c✅ Todas las preguntas respondidas!", "color:lime;font-weight:bold;font-size:14px;");
})();
