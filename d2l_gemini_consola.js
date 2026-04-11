(async () => {
    if (window.__solverActivo) { console.warn("[Solver] Ya está corriendo."); return; }
    window.__solverActivo = true;

    const GROQ_KEYS = ["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", "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", "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", "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", "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", "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"];
    let currentKeyIndex = 0;
    const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
    const MODEL_TEXTO = "qwen/qwen3-32b";
    const MODEL_VISION = "meta-llama/llama-4-scout-17b-16e-instruct";
    const MODEL_BACKUP = "moonshotai/kimi-k2-instruct-0905";
    const nl = String.fromCharCode(10);

    window.__groq__ = window.__groq__ || { visible: false };
    if (window.__groq_toggle_fn__) {
        window.removeEventListener("keydown", window.__groq_toggle_fn__);
        try {
            const i1 = document.getElementById("ctl_2");
            const d = i1?.contentDocument || document;
            d.removeEventListener("keydown", window.__groq_toggle_fn__);
            const i2 = d.querySelector("iframe#FRM_page") || d.querySelector("iframe[name='pageFrame']");
            i2?.contentWindow?.removeEventListener("keydown", window.__groq_toggle_fn__);
        } catch (e) { }
    }
    if (window.__groq_observer__) window.__groq_observer__.disconnect();

    window.__groq_observer__ = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            const div = e.target.__groq_div;
            if (!div) return;
            div.dataset.onScreen = e.isIntersecting ? "true" : "false";
            div.style.display = (window.__groq__.visible && e.isIntersecting) ? "block" : "none";
        });
    }, { threshold: 0.1 });

    // ── KaTeX ─────────────────────────────────────────────
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

    // Convierte símbolos Unicode math a comandos LaTeX válidos
    function unicodeToLaTeX(texto) {
        const map = [
            // Letras griegas
            ['π', '\\pi'], ['θ', '\\theta'], ['α', '\\alpha'], ['β', '\\beta'],
            ['γ', '\\gamma'], ['δ', '\\delta'], ['ε', '\\varepsilon'], ['λ', '\\lambda'],
            ['μ', '\\mu'], ['σ', '\\sigma'], ['ω', '\\omega'], ['φ', '\\varphi'],
            ['τ', '\\tau'], ['ρ', '\\rho'], ['Σ', '\\Sigma'], ['Δ', '\\Delta'],
            ['Ω', '\\Omega'], ['Φ', '\\Phi'],
            // Operadores y símbolos
            ['∫', '\\int'], ['∞', '\\infty'], ['√', '\\sqrt'],
            ['±', '\\pm'], ['∓', '\\mp'], ['×', '\\times'], ['÷', '\\div'],
            ['·', '\\cdot'], ['≈', '\\approx'], ['≠', '\\neq'], ['≤', '\\leq'],
            ['≥', '\\geq'], ['→', '\\to'], ['⇒', '\\Rightarrow'], ['←', '\\leftarrow'],
            ['∂', '\\partial'], ['∇', '\\nabla'], ['∑', '\\sum'], ['∏', '\\prod'],
            ['°', '^{\\circ}'], ['′', "'"],
            // Fracciones Unicode
            ['½', '\\frac{1}{2}'], ['⅓', '\\frac{1}{3}'], ['¼', '\\frac{1}{4}'],
            ['⅔', '\\frac{2}{3}'], ['¾', '\\frac{3}{4}'],
        ];
        for (const [uni, latex] of map) {
            texto = texto.split(uni).join(latex);
        }
        // Detectar superíndices planos: x2 → x^{2}, pero solo patrones como )2, ]2, x2
        // Ej: [f(x)]2 → [f(x)]^{2}, e4x → e^{4x} ya debería ser LaTeX del modelo
        // Detectar subíndices planos comunes: x0, x1, F1, etc.
        // Solo si NO estamos dentro de un bloque LaTeX ya marcado
        return texto;
    }

    // Sanitiza LaTeX malformado que devuelven los LLMs
    function sanitizarLaTeX(texto) {
        // Primero: convertir Unicode a LaTeX
        texto = unicodeToLaTeX(texto);
        // Balancear llaves
        let abiertas = 0;
        for (const c of texto) {
            if (c === '{') abiertas++;
            else if (c === '}') abiertas = Math.max(0, abiertas - 1);
        }
        if (abiertas > 0) texto += '}'.repeat(abiertas);
        // Corregir comandos comunes mal formateados
        texto = texto.replace(/\\text\s+\{/g, '\\text{');
        texto = texto.replace(/\\frac\s+\{/g, '\\frac{');
        texto = texto.replace(/\\sqrt\s+\{/g, '\\sqrt{');
        texto = texto.replace(/\\left\s*\./g, '\\left.');
        texto = texto.replace(/\\right\s*\./g, '\\right.');
        // Doble backslash suelto -> newline LaTeX
        texto = texto.replace(/\\\\(?![a-zA-Z{(\[])/g, ' \\\\ ');
        // Balancear \left y \right
        const lefts = (texto.match(/\\left/g) || []).length;
        const rights = (texto.match(/\\right/g) || []).length;
        if (lefts > rights) {
            for (let i = 0; i < lefts - rights; i++) texto += '\\right.';
        }
        // Cerrar $$ truncados al final
        const ddCount = (texto.match(/\$\$/g) || []).length;
        if (ddCount % 2 !== 0) texto += '$$';
        const sCount = (texto.match(/(?<!\$)\$(?!\$)/g) || []).length;
        if (sCount % 2 !== 0) texto += '$';
        return texto;
    }

    function renderKaTeX(div) {
        if (!window.renderMathInElement) return;
        try {
            window.renderMathInElement(div, KATEX_OPTS);
        } catch (e) {
            // Estilizar errores de KaTeX para que sean legibles
            div.querySelectorAll('.katex-error').forEach(el => {
                el.style.cssText = 'font-family:monospace;font-size:11px;color:#d97706;background:#fef3c7;padding:2px 4px;border-radius:3px;';
            });
            console.warn('[KaTeX] Render parcial:', e.message);
        }
    }

    // Re-renderizar con MutationObserver + múltiples pases para asegurar
    function renderKaTeXConObserver(div) {
        renderKaTeX(div);
        let timeout;
        const obs = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(() => renderKaTeX(div), 80);
        });
        obs.observe(div, { childList: true, subtree: true, characterData: true });
        // Múltiples pases para asegurar renderizado
        [300, 800, 1500, 3000].forEach(t => setTimeout(() => {
            try { renderKaTeX(div); } catch(e) {}
        }, t));
        // Desconectar después de 5s
        setTimeout(() => obs.disconnect(), 5000);
    }

    // ── Indicador disimulado por pregunta ──────────────────
    // Estados: "detect" (gris), "loading" (naranja), "done" (verde), "error" (rojo)
    function crearIndicador(elementoRef) {
        const dot = document.createElement("span");
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
        // Insertarlo justo después del primer hijo visible del elemento de referencia
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
            document.body.appendChild(dot);
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

    // ── Texto y parsing ───────────────────────────────────
    function stripThinking(raw) {
        return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }

    // Parseo robusto: extrae letra y justificacion por separado
    // La justificacion nunca incluye la linea "RESPUESTA: X"
    function parsearRespuesta(raw) {
        const clean = stripThinking(raw);
        // Busca patron "RESPUESTA: X" en cualquier parte del texto
        const match = clean.match(/^([\s\S]*?)\s*RESPUESTA\s*:\s*([A-E])\s*$/im);
        if (match) {
            return {
                justificacion: match[1].trim(),
                letra: match[2].toUpperCase()
            };
        }
        // Fallback: separador ---
        const partes = clean.split(/---+/);
        if (partes.length >= 2) {
            const letraBloque = partes[partes.length - 1].trim();
            const letraMatch = letraBloque.match(/^[A-E]$/);
            if (letraMatch) {
                return {
                    justificacion: partes.slice(0, -1).join("---").trim(),
                    letra: letraMatch[0]
                };
            }
        }
        // Ultimo recurso
        return { justificacion: clean.trim(), letra: extraerLetra(clean) };
    }

    function prepararHTML(texto) {
        // Sanitizar LaTeX antes de cualquier cosa (incluye unicode→LaTeX)
        texto = sanitizarLaTeX(texto);

        // Convertir delimitadores \(...\) y \[...\] a $...$ y $$...$$
        texto = texto.replace(/\\\(/g, "$").replace(/\\\)/g, "$");
        texto = texto.replace(/\\\[/g, "$$").replace(/\\\]/g, "$$");

        // Exclusiones: líneas que empiezan con prosa
        const EXCL = /^(RESPUESTA|So,?\s|First|Next|Let|Here|Note|The\s|This\s|We\s|I\s|then|since|where|porque|aplicando|usando|por lo tanto|entonces|okay|ok\b)/i;

        // Detectar ecuaciones sin delimitadores LaTeX y envolverlas
        const lineas = texto.split(nl).map(l => {
            const trimmed = l.trim();
            if (!trimmed) return '';
            // Si ya tiene delimitadores LaTeX, no tocar
            if (/\$/.test(trimmed)) {
                return l.replace(/[*][*]([^*]+)[*][*]/g, "<strong>$1</strong>");
            }
            // Excluir prosa conocida
            if (EXCL.test(trimmed)) {
                return l.replace(/[*][*]([^*]+)[*][*]/g, "<strong>$1</strong>");
            }
            // Si contiene comandos LaTeX sin delimitadores
            if (/\\(frac|sum|int|sqrt|vec|hat|text|left|right|cdot|times|div|pi|theta|infty|lim|sin|cos|tan|ln|log|arctan|Rightarrow|to|pm|leq|geq|neq|approx)/.test(trimmed)) {
                return '$$' + trimmed + '$$';
            }
            // Si parece una ecuación (tiene = y números/variables)
            if (/=/.test(trimmed) && /[0-9a-zA-Z]/.test(trimmed) && trimmed.length < 200) {
                return '$$' + trimmed + '$$';
            }
            // Si empieza con = (continuación de ecuación)
            if (/^=/.test(trimmed)) {
                return '$$' + trimmed + '$$';
            }
            // Si tiene símbolos math Unicode (ya convertidos a LaTeX por unicodeToLaTeX)
            if (/\\(int|sum|pi|infty|sqrt|to|Rightarrow|pm|approx)/.test(trimmed)) {
                return '$$' + trimmed + '$$';
            }
            return l.replace(/[*][*]([^*]+)[*][*]/g, "<strong>$1</strong>");
        });

        return lineas.join("<br>");
    }

    // Filtra líneas de prosa — solo deja ecuaciones y cálculos
    // AGRESIVO: si tiene más de 5 palabras sin símbolos math, es prosa
    function limpiarJustificacion(texto) {
        // Patrones de prosa comunes (inglés y español)
        const PROSA_REGEX = /^(okay|ok|so,?|let me|let's|first|next|then|here|note|the |this |we |i |now|since|where|therefore|thus|hence|applying|using|by |for |if |it |that |como|porque|aplicando|usando|por lo tanto|entonces|primero|luego|ahora|tenemos|sabemos|dado|sea|consideremos|podemos|recordemos|observemos|veamos|notemos)/i;
        const PROSA_FRASES = /need to|let me|key steps|compute that|find the|determine|check which|approaches|substitut|rearrang|factor|becomes|interval|converge|diverge|is (the|a|an|given|equal|impropia)|we (get|have|know|see|can|need|use|apply|obtain|find)|I (need|will|can)|that (gives|means|is)|the (area|value|result|integral|limit|function|equation|answer)|so (the|we|it|that|this)|in this (case|interval)|it (is|follows|converges|diverges)|which (is|gives|means)|this (is|gives|means)|are (given|to find)|let (us|me|u =|x =|t =)/i;

        const lineas = texto.split('\n').filter(l => {
            const t = l.trim();
            if (!t) return false;
            if (/^RESPUESTA/i.test(t)) return false;

            // PRIMERO: detectar prosa y ELIMINAR
            if (PROSA_REGEX.test(t)) return false;
            if (PROSA_FRASES.test(t)) return false;

            // Contar palabras vs símbolos math
            const soloTexto = t.replace(/\$[^$]*\$/g, '').replace(/\\[a-zA-Z]+/g, '').replace(/[{}()\[\]0-9=+\-*/^_.,;:<>≈→⇒±∑∫|\\]/g, ' ');
            const palabras = soloTexto.split(/\s+/).filter(w => w.length > 2);
            // Si tiene más de 4 palabras "normales" fuera de LaTeX, es prosa
            if (palabras.length > 4 && !/\$/.test(t)) return false;

            // Mantener si tiene LaTeX delimitado
            if (/\$/.test(t)) return true;
            // Mantener si tiene comandos LaTeX
            if (/\\(frac|sum|int|sqrt|vec|text|cdot|times|Rightarrow|left|right|lim|infty|pi|theta|alpha|beta|gamma|mu|sin|cos|tan|ln|log|arctan|cot|sec|csc)/.test(t)) return true;
            // Mantener si tiene símbolos matemáticos con números
            if (/[=≈→⇒±∑∫]/.test(t) && /\d/.test(t)) return true;
            // Mantener sustitución numérica
            if (/\d+[\s]*[+\-*/×÷·]/.test(t) && /=/.test(t)) return true;
            // Mantener unidades
            if (/\d+\.?\d*\s*\\?,?\s*(m\/s|N|kg|J|W|rad|Hz|m\b|cm|km|s\b|°)/.test(t)) return true;
            // Si es corta y tiene = con números, probablemente es cálculo
            if (t.length < 60 && /=/.test(t) && /\d/.test(t)) return true;
            // Eliminar todo lo demás
            return false;
        });
        return lineas.join('\n');
    }

    // ── UI ────────────────────────────────────────────────
    function crearDivJustificacion(p) {
        const el = document.createElement("div");
        el.className = "__groq_justification_div";
        el.style.cssText = "display:none;width:100%;max-height:160px;overflow-y:auto;background:transparent;border-top:1px solid rgba(0,0,0,0.07);font-size:11.5px;padding:8px 0;margin-bottom:12px;font-family:system-ui,sans-serif;color:#333;line-height:1.6;";
        const target = p.elemento;
        if (target.nextSibling) {
            target.parentElement.insertBefore(el, target.nextSibling);
        } else {
            target.parentElement.appendChild(el);
        }
        p.elemento.__groq_div = el;
        window.__groq_observer__.observe(p.elemento);
        return el;
    }

    function actualizarVisibilidad() {
        document.querySelectorAll(".__groq_justification_div").forEach(d => {
            const onScreen = d.dataset.onScreen === "true";
            d.style.display = (window.__groq__.visible && onScreen) ? "block" : "none";
        });
    }

    const toggleX = (e) => {
        if (e.key.toLowerCase() !== "x") return;
        const now = Date.now();
        if (window.__groq_last_t && now - window.__groq_last_t < 300) return;
        window.__groq_last_t = now;
        window.__groq__.visible = !window.__groq__.visible;
        actualizarVisibilidad();
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

    // ── DOM utils ─────────────────────────────────────────
    function htmlToText(html) {
        if (!html) return "";
        const d = document.createElement("div");
        d.innerHTML = html.replace(/&nbsp;/g, " ");
        return (d.textContent || d.innerText || "")
            .replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
    }

    async function extractImageSrc(el) {
        if (!el) return null;
        for (let t = 0; t < 10; t++) {
            const rend = el.querySelector("div.d2l-html-block-rendered img");
            if (rend) return rend.getAttribute("src");
            await new Promise(r => setTimeout(r, 200));
        }
        return el.querySelector("img")?.getAttribute("src");
    }

    async function fetchBase64(src) {
        const url = src.startsWith("http") ? src : window.location.origin + src;
        const r = await fetch(url, { credentials: "include" });
        const b = await r.blob();
        return new Promise((res, rej) => {
            const rd = new FileReader();
            rd.onloadend = () => res({ base64: rd.result.split(",")[1], mimeType: b.type });
            rd.readAsDataURL(b);
        });
    }

    // ── System prompt COMPACTO ────────────────────────────
    // CAMBIO 1: el modelo solo devuelve las operaciones necesarias,
    // sin texto explicativo ni prosa. Solo lo que el estudiante
    // escribe en el papel para justificar.
    const SYSTEM_CALCULO = [
        "You are a math/physics solver. You ONLY output LaTeX equations. NEVER output prose or explanations.",
        "",
        "OUTPUT FORMAT (follow EXACTLY):",
        "- Line 1: base equation in $$...$$",
        "- Line 2: numeric substitution in $$...$$",
        "- Line 3: result with units in $$...$$",
        "- (max 6 equation lines)",
        "- Last line: RESPUESTA: X",
        "",
        "STRICT RULES:",
        "1. EVERY math expression MUST be wrapped in $...$ or $$...$$",
        "2. ZERO words outside of LaTeX \\text{}. NO sentences. NO explanations.",
        "3. FORBIDDEN phrases: 'Let me', 'First', 'So,', 'We have', 'Note that', 'Okay', 'I need', 'The answer', 'Here', 'since', 'because', 'therefore', 'Applying'",
        "4. If you write ANY prose sentence, you have FAILED the task.",
        "",
        "CORRECT example:",
        "$$\\int_{-\\infty}^{\\infty} \\frac{1}{1+x^2}\\,dx = \\left[\\arctan(x)\\right]_{-\\infty}^{\\infty}$$",
        "$$= \\frac{\\pi}{2} - \\left(-\\frac{\\pi}{2}\\right) = \\pi$$",
        "RESPUESTA: C",
        "",
        "WRONG example (NEVER do this):",
        "'Okay, let's see. I need to determine if the improper integral converges...'",
        "'First, since the integral is from -∞ to -1, maybe I can make a substitution...'",
        "",
        "PHYSICS CONTEXT (EAFIT NC1001 — Serway & Jewett 10th ed). g=9.8 m/s².",
        "",
        "NEWTON'S LAWS & FORCES:",
        "- 2nd law: ΣF=ma (always draw FBD first)",
        "- Weight: W=mg, Normal: N⊥surface",
        "- Kinetic friction: f_k=μ_k·N, Static friction: f_s≤μ_s·N",
        "- Tension: same throughout massless rope",
        "- Spring: F=-kx (Hooke's law)",
        "",
        "INCLINED PLANE:",
        "- Parallel: mgsinθ, Perpendicular: mgcosθ",
        "- With friction: a=(gsinθ - μ_k·gcosθ) or a=(gsinθ + μ_k·gcosθ)",
        "- N=mgcosθ on incline",
        "",
        "ATWOOD MACHINE & PULLEYS:",
        "- Two masses: a=(m₁-m₂)g/(m₁+m₂), T=2m₁m₂g/(m₁+m₂)",
        "- Modified Atwood: one mass on table, one hanging",
        "- Pulley systems: constraint equations for acceleration",
        "",
        "CIRCULAR MOTION:",
        "- Centripetal: ΣF=mv²/r, a_c=v²/r",
        "- Banked curves: tanθ=v²/(rg) (no friction)",
        "- Vertical circle: v_min=√(gr) at top",
        "",
        "PENDULUM:",
        "- Period: T=2π√(L/g) (simple), T=2π√(I/(mgd)) (physical)",
        "- Tension at bottom: T=mg+mv²/L",
        "",
        "WORK & ENERGY:",
        "- W=Fd·cosθ, W_net=ΔK",
        "- K=½mv², U_g=mgh, U_s=½kx²",
        "- Conservation: K_i+U_i+W_nc=K_f+U_f",
        "- With friction: K_i+U_i=K_f+U_f+f_k·d",
        "- Power: P=Fv, P=W/t",
        "",
        "MOMENTUM & COLLISIONS:",
        "- p=mv, Impulse: J=FΔt=Δp",
        "- Conservation: Σp_i=Σp_f (if ΣF_ext=0)",
        "- Perfectly inelastic: m₁v₁+m₂v₂=(m₁+m₂)v_f",
        "- Elastic: p AND K conserved, v₁f=((m₁-m₂)/(m₁+m₂))v₁i",
        "- 2D collisions: conserve p_x and p_y separately",
        "",
        "CALCULUS (integrals, derivatives, limits, series):",
        "- Improper integrals: evaluate as limits",
        "- Convergence tests: comparison, ratio, integral test",
        "- Integration techniques: substitution, by parts, partial fractions",
        "- Common: ∫1/(1+x²)dx=arctan(x), ∫e^x dx=e^x",
        "",
        "RESPUESTA: X always on the LAST line. X = A, B, C, D or E."
    ].join(nl);

    // ── Extracción de letra ───────────────────────────────
    function extraerLetra(raw) {
        const clean = stripThinking(raw);
        const lines = clean.split(/[\r\n]+/);
        const respTag = clean.match(/RESPUESTA\s*:\s*([A-E])/i);
        if (respTag) return respTag[1].toUpperCase();
        const sepIdx = lines.map(l => l.trim()).lastIndexOf("---");
        if (sepIdx !== -1) {
            const after = lines.slice(sepIdx + 1).map(l => l.trim()).filter(l => l.length > 0);
            if (after.length > 0 && /^[A-E]$/.test(after[0])) return after[0];
        }
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i].trim();
            if (/^[A-E]$/.test(l)) return l;
        }
        const tail = clean.slice(-300);
        const m = tail.match(/(?:respuesta|opci[oó]n|letra)[^A-Za-z]*([A-E])(?:[^A-Za-z]|$)/i);
        if (m) return m[1].toUpperCase();
        return "A";
    }

    // ── API con rotación de keys ──────────────────────────
    async function preguntarAI(enunciado, opciones, imagen) {
        const optsStr = opciones.map(o => o.letra + ") " + (o.htmlRaw || o.texto)).join(nl);
        const model = imagen ? MODEL_VISION : MODEL_TEXTO;

        const userMsg = "ONLY LaTeX equations. NO text. NO explanations." + nl + "PREGUNTA:" + nl + enunciado + nl + nl + "OPCIONES:" + nl + optsStr + nl + nl + "Reply with ONLY $$...$$ equations then RESPUESTA: X";

        const construirPayload = (modeloParam) => {
            const p = {
                model: modeloParam,
                messages: [
                    { role: "system", content: SYSTEM_CALCULO },
                    { role: "user", content: userMsg }
                ],
                max_tokens: 1200,
                temperature: 0.1
            };
            if (imagen) {
                p.messages[1].content = [
                    { type: "text", text: userMsg },
                    { type: "image_url", image_url: { url: "data:" + imagen.mimeType + ";base64," + imagen.base64 } }
                ];
            }
            return p;
        };

        const hacerPeticion = async (modeloParam) => {
            for (let i = 0; i < GROQ_KEYS.length * 3; i++) {
                const key = GROQ_KEYS[currentKeyIndex];
                try {
                    const r = await fetch(GROQ_URL, {
                        method: "POST",
                        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
                        body: JSON.stringify(construirPayload(modeloParam))
                    });
                    if (r.status === 429) {
                        const txt = await r.text();
                        const m = txt.match(/try again in ([\d.]+)s/);
                        const w = m ? Math.ceil(parseFloat(m[1])) + 2 : 20;
                        currentKeyIndex = (currentKeyIndex + 1) % GROQ_KEYS.length;
                        console.log("[Solver] Rate limit — rotando key, esperando " + w + "s...");
                        await new Promise(res => setTimeout(res, w * 1000));
                        continue;
                    }
                    if (r.status === 413) throw new Error("Payload too large (413)");
                    if (!r.ok) throw new Error("API Error " + r.status);
                    const data = await r.json();
                    if (!data?.choices?.[0]?.message?.content) throw new Error("Respuesta vacía");
                    return data;
                } catch (err) {
                    if (err.message.includes("413")) throw err;
                    if (i === GROQ_KEYS.length * 3 - 1) throw err;
                    currentKeyIndex = (currentKeyIndex + 1) % GROQ_KEYS.length;
                    await new Promise(res => setTimeout(res, 2000));
                }
            }
            throw new Error("Se agotaron todos los intentos");
        };

        let data;
        try { data = await hacerPeticion(model); }
        catch (e) {
            console.warn("[Solver] Principal falló (" + e.message + "), usando backup...");
            data = await hacerPeticion(MODEL_BACKUP);
        }

        const raw = data.choices[0].message.content;
        const res = parsearRespuesta(raw);
        return { letra: res.letra, justificacion: res.justificacion };
    }

    function marcar(p, letra) {
        const idx = "ABCDE".indexOf(letra);
        if (p.tipo === "parcial") {
            const inputs = p.elemento.querySelectorAll("tr.d2l-rowshadeonhover input[type=radio]");
            inputs[idx]?.click();
        } else {
            const input = p.opts[idx]?.row.querySelector("input[type=radio]");
            input?.click();
        }
    }

    // ── Motor principal ───────────────────────────────────
    await cargarKaTeX();

    const doc = (() => {
        try {
            const i1 = document.getElementById("ctl_2");
            const d = i1?.contentDocument || document;
            const i2 = d.querySelector("iframe#FRM_page") || d.querySelector("iframe[name='pageFrame']");
            return i2?.contentDocument || d;
        } catch (e) { return document; }
    })();

    function buscarEnunciado(elemento) {
        let prev = elemento.previousElementSibling;
        while (prev) {
            if (prev.tagName.toLowerCase() === "d2l-html-block") return prev;
            const inner = prev.querySelector("d2l-html-block");
            if (inner && !prev.querySelector("input[type=radio]")) return inner;
            prev = prev.previousElementSibling;
        }
        return null;
    }

    const questions = [];

    doc.querySelectorAll("fieldset.dfs_m").forEach(fs => {
        const opts = [];
        fs.querySelectorAll("tr.d2l-rowshadeonhover").forEach((r, i) => {
            const b = r.querySelector("d2l-html-block");
            opts.push({
                row: r,
                letra: "ABCDE"[i],
                texto: htmlToText(b?.getAttribute("html")),
                htmlRaw: b?.getAttribute("html") || ""
            });
        });
        const b = buscarEnunciado(fs);
        questions.push({ tipo: "parcial", elemento: fs, opts, b });
    });

    if (questions.length === 0) {
        doc.querySelectorAll(".d2l-quiz-question-autosave-container").forEach(c => {
            const allBlocks = Array.from(c.querySelectorAll("d2l-html-block"));
            const b = allBlocks.find(block => {
                const tr = block.closest("tr");
                return !tr || !tr.querySelector("input[type=radio]");
            });
            const opts = [];
            c.querySelectorAll("tr").forEach((r) => {
                const radio = r.querySelector("input[type=radio]");
                const block = r.querySelector("d2l-html-block");
                if (radio && block) opts.push({
                    row: r,
                    letra: "ABCDE"[opts.length],
                    texto: htmlToText(block.getAttribute("html")),
                    htmlRaw: block.getAttribute("html") || ""
                });
            });
            questions.push({ tipo: "quiz", elemento: c, opts, b });
        });
    }

    console.log("%c⚡ Solver v26-MOD — " + questions.length + " preguntas", "color:#00ff88;font-weight:bold;font-size:13px;");

    for (let i = 0; i < questions.length; i++) {
        const p = questions[i];
        const div = crearDivJustificacion(p);

        // CAMBIO 2: indicador disimulado — punto de color junto al elemento
        const dot = crearIndicador(p.elemento);
        setIndicador(dot, "detect");

        div.innerHTML = "<em style='opacity:0.5;font-size:11px;'>cargando...</em>";
        if (window.__groq__.visible) div.style.display = "block";

        // Estado: detectado
        await new Promise(r => setTimeout(r, 80));
        setIndicador(dot, "loading");

        try {
            const enunciado = htmlToText(p.b?.getAttribute("html") || "");
            const src = await extractImageSrc(p.b);
            const img = src ? await fetchBase64(src) : null;

            const res = await preguntarAI(enunciado, p.opts, img);

            // Estado: respondido
            setIndicador(dot, "done");

            // Post-procesar: eliminar prosa, dejar solo cálculos
            const justLimpia = limpiarJustificacion(res.justificacion);

            div.innerHTML =
                "<div class='__groq_content' style='font-family:system-ui,sans-serif;font-size:12px;line-height:1.8;'>" +
                prepararHTML(justLimpia) +
                "</div>" +
                "<div style='color:#16a34a;font-weight:bold;margin-top:8px;font-size:13px;'>✓ " + res.letra + "</div>";

            // Render con MutationObserver (mas robusto que multiples timeouts)
            renderKaTeXConObserver(div);

            // Render KaTeX tambien en los textos de las opciones si tienen formulas
            p.opts.forEach(o => {
                if (o.htmlRaw && (o.htmlRaw.includes("$") || o.htmlRaw.includes("\\(") || o.htmlRaw.includes("\\[")))
                    renderKaTeX(o.row);
            });

            marcar(p, res.letra);
            console.log("%c✅ P" + (i + 1) + " → " + res.letra, "color:lime;font-weight:bold;");

            if (i < questions.length - 1) {
                const delay = 12000 + Math.random() * 8000;
                await new Promise(r => setTimeout(r, delay));
            }
        } catch (e) {
            setIndicador(dot, "error");
            div.innerHTML = "<span style='color:#dc2626;font-size:11px;'>❌ " + e.message + "</span>";
            console.error("Error P" + (i + 1), e);
        }
    }

    console.log("%c✅ Solver v26-MOD completado.", "color:lime;font-weight:bold;font-size:14px;");
})();
