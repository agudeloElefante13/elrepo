(async () => {
  if (window.__solverActivo) {
    console.warn("[Helper] Ya está corriendo.");
    return;
  }
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
    link.href =
      "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css";
    document.head.appendChild(link);
    const loadScript = (src) =>
      new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
    await loadScript(
      "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js",
    );
    await loadScript(
      "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js",
    );
  }

  const KATEX_OPTS = {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
      { left: "\\[", right: "\\]", display: true },
    ],
    throwOnError: false,
    strict: false,
  };

  function renderKaTeX(div) {
    if (!window.renderMathInElement) return;
    try {
      window.renderMathInElement(div, KATEX_OPTS);
    } catch (e) {}
  }

  // ── LaTeX Utilities (Ported from helper.html) ──────────
  function unicodeToLaTeX(texto) {
    const map = [
      ["π", "\\pi"],
      ["θ", "\\theta"],
      ["α", "\\alpha"],
      ["β", "\\beta"],
      ["γ", "\\gamma"],
      ["δ", "\\delta"],
      ["ε", "\\varepsilon"],
      ["λ", "\\lambda"],
      ["μ", "\\mu"],
      ["σ", "\\sigma"],
      ["ω", "\\omega"],
      ["φ", "\\varphi"],
      ["τ", "\\tau"],
      ["ρ", "\\rho"],
      ["Σ", "\\Sigma"],
      ["Δ", "\\Delta"],
      ["Ω", "\\Omega"],
      ["Φ", "\\Phi"],
      ["∫", "\\int"],
      ["∞", "\\infty"],
      ["√", "\\sqrt"],
      ["±", "\\pm"],
      ["∓", "\\mp"],
      ["×", "\\times"],
      ["÷", "\\div"],
      ["·", "\\cdot"],
      ["≈", "\\approx"],
      ["≠", "\\neq"],
      ["≤", "\\leq"],
      ["≥", "\\geq"],
      ["→", "\\to"],
      ["⇒", "\\Rightarrow"],
      ["←", "\\leftarrow"],
      ["∂", "\\partial"],
      ["∇", "\\nabla"],
      ["∑", "\\sum"],
      ["∏", "\\prod"],
      ["°", "^{\\circ}"],
      ["′", "'"],
      ["½", "\\frac{1}{2}"],
      ["⅓", "\\frac{1}{3}"],
      ["¼", "\\frac{1}{4}"],
      ["⅔", "\\frac{2}{3}"],
      ["¾", "\\frac{3}{4}"],
    ];
    for (const [uni, latex] of map) {
      texto = texto.split(uni).join(latex);
    }
    return texto;
  }

  function sanitizarLaTeX(texto) {
    if (!texto) return "";
    texto = unicodeToLaTeX(texto);

    // Balancear llaves
    let abiertas = 0;
    for (const c of texto) {
      if (c === "{") abiertas++;
      else if (c === "}") abiertas = Math.max(0, abiertas - 1);
    }
    if (abiertas > 0) texto += "}".repeat(abiertas);

    // Corregir comandos comunes
    texto = texto.replace(/\\text\s+\{/g, "\\text{");
    texto = texto.replace(/\\frac\s+\{/g, "\\frac{");
    texto = texto.replace(/\\sqrt\s+\{/g, "\\sqrt{");
    texto = texto.replace(/\\left\s*\./g, "\\left.");
    texto = texto.replace(/\\right\s*\./g, "\\right.");

    // Cerrar $$ y $ truncados
    const ddCount = (texto.match(/\$\$/g) || []).length;
    if (ddCount % 2 !== 0) texto += "$$";
    const sCount = (texto.match(/(?<!\$)\$(?!\$)/g) || []).length;
    if (sCount % 2 !== 0) texto += "$";

    return texto;
  }

  function prepararHTML(texto) {
    if (!texto) return "";

    // 1. Limpieza inicial
    texto = sanitizarLaTeX(texto);

    // 2. Normalizar delimitadores \(...\) -> $ y \[...\] -> $$
    texto = texto
      .split("\\(")
      .join("$")
      .split("\\)")
      .join("$")
      .split("\\[")
      .join("$$")
      .split("\\]")
      .join("$$");

    // 3. Filtrado para "Solo LaTeX" (Evitar duplicados)
    // Si el texto contiene bloques $$, extraemos solo esos bloques para evitar el texto plano redundante a la izquierda.
    if (texto.includes("$$")) {
      const regexBlocks = /(\$\$.*?\$\$)/gs;
      const matches = [...texto.matchAll(regexBlocks)];
      if (matches.length > 0) {
        // Si encontramos bloques, retornamos solo esos bloques unidos
        return matches.map((m) => m[0]).join("<br>");
      }
    }

    // 4. Si no hay bloques $$ o el filtrado no aplicó, procesamos normalmente (Markdown + saltos)
    let result = "";
    let inBlock = false;
    let i = 0;
    while (i < texto.length) {
      if (!inBlock && texto[i] === "$" && texto[i + 1] === "$") {
        inBlock = true;
        result += "$$";
        i += 2;
        continue;
      }
      if (inBlock && texto[i] === "$" && texto[i + 1] === "$") {
        inBlock = false;
        result += "$$";
        i += 2;
        continue;
      }
      if (!inBlock && texto[i] === "\n") {
        result += "<br>";
        i++;
        continue;
      }
      result += texto[i];
      i++;
    }

    return result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  // ── Justificación UI ─────────────────────────────────────
  window.__groq__ = window.__groq__ || { visible: false };

  // IntersectionObserver para mostrar/ocultar justificaciones
  if (window.__groq_observer__) window.__groq_observer__.disconnect();
  window.__groq_observer__ = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        const div = e.target.__groq_div;
        if (!div) return;
        div.dataset.onScreen = e.isIntersecting ? "true" : "false";
        // Mostrar si: global visible O individualmente abierto
        const shouldShow =
          e.isIntersecting &&
          (window.__groq__.visible || div.dataset.clicked === "true");
        div.style.display = shouldShow ? "block" : "none";
      });
    },
    { threshold: 0.1 },
  );

  function crearDivJustificacion(p, targetDoc) {
    if (!targetDoc.getElementById("__groq_stealth_style")) {
      const style = targetDoc.createElement("style");
      style.id = "__groq_stealth_style";
      style.textContent = `
        .__groq_justification_div::-webkit-scrollbar,
        .__groq_chat_msgs::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
          background: transparent !important;
        }
      `;
      if (targetDoc.head) {
        targetDoc.head.appendChild(style);
      }
    }

    const el = targetDoc.createElement("div");
    el.className = "__groq_justification_div";
    el.dataset.clicked = "false";
    el.style.cssText =
      "display:none;width:100%;max-height:350px;overflow-y:auto;background:transparent;border-top:1px solid rgba(0,0,0,0.07);font-size:12px;padding:8px 0;margin-bottom:12px;font-family:system-ui,sans-serif;color:#333;line-height:1.7;scrollbar-width:none;-ms-overflow-style:none;";

    // Justification content area
    const justContent = targetDoc.createElement("div");
    justContent.className = "__groq_just_content";
    // Agregar padding inferior masivo para permitir scrollear y camuflar la respuesta
    justContent.style.paddingBottom = "400px";
    el.appendChild(justContent);

    // Chat section — ultra disimulado, parece metadata de D2L
    const chatSection = targetDoc.createElement("div");
    chatSection.style.cssText = "margin-top:4px;padding-top:3px;";

    // Toggle: un mini texto gris que parece un link de "más info" de D2L
    const chatToggle = targetDoc.createElement("span");
    chatToggle.style.cssText =
      "font-size:9px;color:rgba(0,0,0,0.2);cursor:pointer;font-family:system-ui,sans-serif;letter-spacing:0.02em;user-select:none;";
    chatToggle.textContent = "· · ·";
    chatToggle.title = "";

    const chatBody = targetDoc.createElement("div");
    chatBody.style.cssText = "display:none;margin-top:4px;";

    chatToggle.addEventListener("click", () => {
      chatBody.style.display =
        chatBody.style.display === "none" ? "block" : "none";
    });

    const chatMsgs = targetDoc.createElement("div");
    chatMsgs.className = "__groq_chat_msgs";
    chatMsgs.style.cssText =
      "max-height:80px;overflow-y:auto;margin-bottom:3px;scrollbar-width:none;-ms-overflow-style:none;";

    const chatRow = targetDoc.createElement("div");
    chatRow.style.cssText = "display:flex;gap:3px;align-items:center;";

    const chatInput = targetDoc.createElement("input");
    chatInput.type = "text";
    chatInput.className = "__groq_chat_input";
    chatInput.placeholder = "";
    chatInput.style.cssText =
      "flex:1;padding:2px 4px;font-size:10px;font-family:system-ui,sans-serif;border:none;border-bottom:1px solid rgba(0,0,0,0.08);outline:none;background:transparent;color:rgba(0,0,0,0.35);";

    const chatSend = targetDoc.createElement("button");
    chatSend.textContent = "›";
    chatSend.style.cssText =
      "padding:1px 4px;font-size:10px;border:none;background:transparent;color:rgba(0,0,0,0.2);cursor:pointer;font-family:system-ui;line-height:1;";

    chatRow.appendChild(chatInput);
    chatRow.appendChild(chatSend);
    chatBody.appendChild(chatMsgs);
    chatBody.appendChild(chatRow);
    chatSection.appendChild(chatToggle);
    chatSection.appendChild(chatBody);
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
    [document, getQuizDoc()].forEach((d) => {
      try {
        d.querySelectorAll(".__groq_justification_div").forEach((div) => {
          const onScreen = div.dataset.onScreen === "true";
          if (window.__groq__.visible) {
            div.style.display = onScreen ? "block" : "none";
          } else {
            // Cuando se apaga global, respetar los individuales
            const clicked = div.dataset.clicked === "true";
            div.style.display = clicked && onScreen ? "block" : "none";
          }
        });
      } catch (e) {}
    });
  }

  // ── Toggle X — mostrar/ocultar justificaciones ──
  if (window.__groq_toggle_fn__) {
    window.removeEventListener("keydown", window.__groq_toggle_fn__);
    try {
      const i1 = document.getElementById("ctl_2");
      const d = i1?.contentDocument || document;
      d.removeEventListener("keydown", window.__groq_toggle_fn__);
    } catch (e) {}
  }
  const toggleX = (e) => {
    if (e.key.toLowerCase() !== "x") return;
    const now = Date.now();
    if (window.__groq_last_t && now - window.__groq_last_t < 300) return;
    window.__groq_last_t = now;
    window.__groq__.visible = !window.__groq__.visible;
    actualizarVisibilidad();
    console.log(
      "[Helper] Justificaciones " +
        (window.__groq__.visible ? "visibles" : "ocultas"),
    );
  };
  window.__groq_toggle_fn__ = toggleX;
  window.addEventListener("keydown", toggleX);
  try {
    const i1 = document.getElementById("ctl_2");
    const d = i1?.contentDocument || document;
    d.addEventListener("keydown", toggleX);
    const i2 =
      d.querySelector("iframe#FRM_page") ||
      d.querySelector("iframe[name='pageFrame']");
    i2?.contentWindow?.addEventListener("keydown", toggleX);
  } catch (e) {}

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
      "top:-1px",
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
      graph: { bg: "#38bdf8", op: "0.80" }, // Color azul para gráficas
      error: { bg: "#ef4444", op: "0.55" },
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
    if (window.__helper_last_z__ && now - window.__helper_last_z__ < 300)
      return;
    window.__helper_last_z__ = now;
    window.__helper_visible__ = !window.__helper_visible__;
    const visible = window.__helper_visible__;
    [document, getQuizDoc()].forEach((d) => {
      try {
        d.querySelectorAll(".__helper_dot__").forEach(
          (dot) => (dot.style.display = visible ? "inline-block" : "none"),
        );
      } catch (err) {}
    });
  };
  window.addEventListener("keydown", toggleZ);
  try {
    const i1 = document.getElementById("ctl_2");
    const d = i1?.contentDocument || document;
    d.addEventListener("keydown", toggleZ);
    const i2 =
      d.querySelector("iframe#FRM_page") ||
      d.querySelector("iframe[name='pageFrame']");
    i2?.contentWindow?.addEventListener("keydown", toggleZ);
  } catch (e) {}

  // ── DOM Utilities ──────────────────────────────────────────

  function htmlToText(html) {
    if (!html) return "";
    const d = document.createElement("div");
    d.innerHTML = html.replace(/&nbsp;/g, " ");
    return (d.textContent || d.innerText || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/ {2,}/g, " ")
      .trim();
  }

  function getQuizDoc() {
    try {
      const i1 = document.getElementById("ctl_2");
      const d1 = i1?.contentDocument;
      const i2 =
        d1?.getElementById("FRM_page") ||
        d1?.querySelector("iframe[name='pageFrame']");
      if (i2?.contentDocument) return i2.contentDocument;
      if (d1) return d1;
    } catch (e) {}
    return document;
  }

  async function extractImageSrc(el) {
    if (!el) return null;
    for (let t = 0; t < 8; t++) {
      // 1. Buscar en el renderizado
      const img =
        el.querySelector("div.d2l-html-block-rendered img") ||
        el.querySelector("img");
      if (img) return img.getAttribute("src");

      // 2. Buscar en el atributo "html" del bloque (si es uno o contiene uno)
      const block =
        el.tagName?.toLowerCase() === "d2l-html-block"
          ? el
          : el.querySelector("d2l-html-block");
      const h = block?.getAttribute("html");
      if (h) {
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = h;
        const i = tempDiv.querySelector("img");
        if (i) return i.getAttribute("src");
      }

      await new Promise((r) => setTimeout(r, 200));
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

    // 6. Búsqueda profunda: parsear atributo html de todos los d2l-html-block internos
    const allBlocks = [
      ...Array.from(p.elemento.querySelectorAll("d2l-html-block")),
      ...Array.from(
        p.elemento.parentElement?.querySelectorAll("d2l-html-block") || [],
      ),
    ];
    for (const b of allBlocks) {
      const h = b.getAttribute("html");
      if (h) {
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = h;
        const i = tempDiv.querySelector("img");
        if (i) return i.getAttribute("src");
      }
    }

    return null;
  }

  async function fetchBase64(src) {
    const url = src.startsWith("http") ? src : window.location.origin + src;
    const r = await fetch(url, { credentials: "include" });
    const b = await r.blob();
    return new Promise((res) => {
      const rd = new FileReader();
      rd.onloadend = () =>
        res({ base64: rd.result.split(",")[1], mimeType: b.type });
      rd.readAsDataURL(b);
    });
  }

  function marcar(p, letra) {
    // Deshabilitado: ya no automatizamos las respuestas.
    console.log(
      "[Helper] Marcar sugerido pero deshabilitado manual. Letra:",
      letra,
    );
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

  // Tipo 1: parcial y Tipo 3: matching
  quizDoc.querySelectorAll("fieldset.dfs_m").forEach((fs) => {
    questions.push({ elemento: fs, b: buscarEnunciado(fs) });
  });

  // Tipo 2: quiz
  if (questions.length === 0) {
    quizDoc
      .querySelectorAll(".d2l-quiz-question-autosave-container")
      .forEach((c) => {
        const allBlocks = Array.from(c.querySelectorAll("d2l-html-block"));
        const b = allBlocks.find(
          (block) => !block.closest("tr")?.querySelector("input[type=radio]"),
        );
        questions.push({ elemento: c, b });
      });
  }

  console.log(
    "%c⚡ Helper Mode v2 (Generic) — " +
      questions.length +
      " preguntas detectadas",
    "color:#00ff88;font-weight:bold;font-size:13px;",
  );

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
  console.log("[Helper] Extrayendo datos en crudo de las preguntas...");
  const questionData = [];

  for (let i = 0; i < questions.length; i++) {
    const p = questions[i];

    // Creamos un div virtual para encapsular todo el contenido de la pregunta
    const virtualWrapper = document.createElement("div");
    virtualWrapper.style.display = "flex";
    virtualWrapper.style.flexDirection = "column";
    virtualWrapper.style.gap = "15px";

    // 1. Agregar el enunciado (generalmente está por fuera del contenedor de opciones)
    if (p.b) {
      const preambleContainer = document.createElement("div");
      preambleContainer.className = "preamble-container";
      preambleContainer.innerHTML =
        p.b.getAttribute("html") || p.b.innerHTML || p.b.outerHTML || "";
      virtualWrapper.appendChild(preambleContainer);
    }

    // 2. Agregar las opciones (fieldset o autosave-container)
    const cloneElement = p.elemento.cloneNode(true);
    // Remueve márgenes molestos de D2L que comprimen visualmente en el helper
    cloneElement.style.margin = "0";
    virtualWrapper.appendChild(cloneElement);

    // 2.5 TRANSFORMAR d2l-html-block
    // D2L usa Web Components que no renderizan en el Helper sin su JS.
    // Convertimos <d2l-html-block html="..."> a <div> normales con su contenido
    const d2lBlocks = virtualWrapper.querySelectorAll("d2l-html-block");
    for (let block of d2lBlocks) {
      const rawHtml = block.getAttribute("html") || block.innerHTML;
      const divNormal = document.createElement("div");
      divNormal.style.display = "inline-block";
      divNormal.style.width = "100%";
      divNormal.innerHTML = rawHtml;
      block.parentNode.replaceChild(divNormal, block);
    }

    // 3. Convertir TODAS las imagenes del virtualWrapper a base 64
    const imgs = virtualWrapper.querySelectorAll("img");
    if (imgs.length > 0) {
      console.log(
        "[Helper] P" +
          (i + 1) +
          " procesando " +
          imgs.length +
          " imágenes a base64 (formulas incluidas)...",
      );
    }
    for (let img of imgs) {
      try {
        const src = img.getAttribute("src");
        if (src) {
          const imgB64 = await fetchBase64(src);
          img.setAttribute(
            "src",
            "data:" + imgB64.mimeType + ";base64," + imgB64.base64,
          );
        }
      } catch (e) {
        console.warn(
          "No se pudo convertir a base64 la imagen:",
          Math.round(i),
          e,
        );
      }
    }

    questionData.push({
      index: i,
      htmlRaw: virtualWrapper.innerHTML,
    });
    setIndicador(dots[i], "loading");
  }

  // ── Extraer nombre automáticamente de D2L ──
  function extraerNombreD2L() {
    // Buscar en todos los documentos posibles (top, iframes)
    const docs = [document];
    try {
      if (window.top?.document && window.top.document !== document)
        docs.push(window.top.document);
    } catch (e) {}
    try {
      const i1 = document.getElementById("ctl_2");
      if (i1?.contentDocument) docs.push(i1.contentDocument);
    } catch (e) {}

    const intentos = [
      // 1. Label "Usuario actual" → siguiente div con el nombre (MÁS CONFIABLE)
      (doc) => {
        const labels = doc.querySelectorAll("label.d2l-label-text");
        for (const label of labels) {
          if (/usuario actual/i.test(label.textContent)) {
            const div = label.nextElementSibling;
            if (div) {
              const text = div.textContent.trim();
              const match = text.match(/^(.+?)\s*\(nombre de usuario:/i);
              return match ? match[1].trim() : text.split("(")[0].trim();
            }
          }
        }
        return null;
      },
      // 2. Web component de menú personal
      (doc) =>
        doc
          .querySelector("d2l-navigation-link-personal-menu")
          ?.getAttribute("text"),
      (doc) =>
        doc
          .querySelector("d2l-navigation-link-personal-menu")
          ?.textContent?.trim(),
      // 3. Botón de perfil con aria-label
      (doc) => {
        const btn = doc.querySelector(
          '[data-testid="d2l-navigation-s-personal-menu"]',
        );
        return (
          btn
            ?.getAttribute("aria-label")
            ?.replace(
              /^(menú personal|personal menu|perfil|profile)\s*[-–:]\s*/i,
              "",
            ) || btn?.textContent?.trim()
        );
      },
      // 4. Dropdown del menú personal
      (doc) =>
        doc
          .querySelector(".d2l-navigation-s-personal-menu-text")
          ?.textContent?.trim(),
      (doc) =>
        doc
          .querySelector(".d2l-navigation-s-header-personal-menu-text")
          ?.textContent?.trim(),
      // 5. Cualquier elemento con clase que contenga "personal-menu"
      (doc) => {
        const el = doc.querySelector('[class*="personal-menu"]');
        const text = el?.getAttribute("text") || el?.textContent?.trim();
        return text && text.length > 2 && text.length < 80 ? text : null;
      },
      // 6. Buscar en el dropdown abierto
      (doc) =>
        doc
          .querySelector(".d2l-dropdown-content-pointer .d2l-profile-card-name")
          ?.textContent?.trim(),
      // 7. Nombre en la barra superior como texto
      (doc) => {
        const nav = doc.querySelector("d2l-navigation, .d2l-navigation");
        if (!nav) return null;
        const els = nav.querySelectorAll("span, div, button");
        for (const el of els) {
          const t = el.textContent?.trim();
          if (
            t &&
            t.length > 3 &&
            t.length < 50 &&
            t.includes(" ") &&
            !/home|inicio|quiz|assignment|content|grades|menú|menu|notification|help/i.test(
              t,
            )
          ) {
            return t;
          }
        }
        return null;
      },
    ];

    for (const doc of docs) {
      for (const intento of intentos) {
        try {
          const resultado = intento(doc);
          if (resultado && resultado.trim().length > 2) {
            console.log("[Helper] Nombre extraído de D2L:", resultado.trim());
            return resultado.trim();
          }
        } catch (e) {}
      }
    }
    return null;
  }

  function generarCodigo(nombre) {
    return nombre
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/\s+/)
      .map((p) => p.substring(0, 2))
      .join("");
  }

  let nombreCompleto = extraerNombreD2L();
  if (!nombreCompleto) {
    // Input disimulado en el footer del quiz, parece metadata de D2L
    nombreCompleto = await new Promise((resolve) => {
      const targetDoc = getQuizDoc();
      const footer = targetDoc.createElement("div");
      footer.style.cssText =
        "padding:6px 10px;margin-top:12px;font-size:10px;color:#999;font-family:'D2L',system-ui,sans-serif;display:flex;align-items:center;gap:6px;border-top:1px solid #e5e5e5;";
      const lbl = targetDoc.createElement("span");
      lbl.textContent = "Session user:";
      const inp = targetDoc.createElement("input");
      inp.style.cssText =
        "border:none;border-bottom:1px solid #ccc;background:transparent;font-size:10px;color:#777;font-family:inherit;outline:none;padding:1px 4px;width:140px;";
      inp.placeholder = "full name";
      footer.appendChild(lbl);
      footer.appendChild(inp);
      targetDoc.body.appendChild(footer);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && inp.value.trim()) {
          footer.remove();
          resolve(inp.value.trim());
        }
      });
      inp.addEventListener("blur", () => {
        if (inp.value.trim()) {
          footer.remove();
          resolve(inp.value.trim());
        }
      });
    });
  }
  if (!nombreCompleto) nombreCompleto = "Anónimo";
  console.log(
    "%c👤 " + nombreCompleto + " → " + generarCodigo(nombreCompleto),
    "color:#38bdf8;font-weight:bold;",
  );
  const nombreCodigo = generarCodigo(nombreCompleto);

  // Extraer HTML completo para debugging
  let pageHTML = "";
  try {
    let parentClone = document.documentElement.cloneNode(true);

    // 1. Inyectar <base> para que el CSS / recursos estáticos (que tienen URLs relativas) carguen desde el D2L original
    let base = document.createElement("base");
    base.href = window.location.origin;
    const head = parentClone.querySelector("head");
    if (head) head.prepend(base);

    // 2. Si D2L metió el quiz en un iframe, el Iframe original vendrá hueco en el clone. Vamos a empaquetarlo.
    const qDoc = getQuizDoc();
    if (qDoc && qDoc !== document) {
      // Buscar el iframe dentro del clon que corresponda
      const iframeClone = parentClone.querySelector(
        'iframe[name="contentFrame"], iframe.d2l-iframe, iframe',
      );
      if (iframeClone && qDoc.documentElement) {
        let innerClone = qDoc.documentElement.cloneNode(true);
        let innerBase = document.createElement("base");
        innerBase.href = window.location.origin;
        const innerHead = innerClone.querySelector("head");
        if (innerHead) innerHead.prepend(innerBase);

        iframeClone.removeAttribute("src"); // Evitar que redireccione o dé error
        // Inyectamos todo el sub-html dentro del atributo srcdoc
        iframeClone.setAttribute("srcdoc", innerClone.outerHTML);
        // Expandimos el iframe para que esté completamente visible sin scroll absurdo
        iframeClone.style.height = "2500px";
      }
    }

    pageHTML = "<!DOCTYPE html>\n" + parentClone.outerHTML;
    console.log(
      "[Helper Debug] HTML empaquetado estilo Ctrl+S exitosamente. Tamaño:",
      pageHTML.length,
      "bytes",
    );
  } catch (e) {
    pageHTML = "<!-- Error extrayendo HTML: " + e.message + " -->";
    console.warn("[Helper Debug] No se pudo extraer el HTML de la página:", e);
  }

  // Crear sesión
  let sessionId = null;
  try {
    console.log(
      "[Helper Debug] Creando sesión, enviando POST con pageHTML de",
      pageHTML.length,
      "bytes...",
    );
    const res = await fetch(WORKER_URL + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions: questionData,
        nombre: nombreCodigo,
        nombreCompleto: nombreCompleto.trim(),
        pageHTML: pageHTML,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    sessionId = data.sessionId;
    console.log(
      "%c📋 Sesión " + sessionId + " — " + data.total + " preguntas enviadas",
      "color:#38bdf8;font-weight:bold;font-size:13px;",
    );
    console.log(
      "%c🔗 Helper: " + WORKER_URL + "/helper?s=" + sessionId,
      "color:#38bdf8;font-weight:bold;font-size:14px;",
    );
  } catch (e) {
    console.error("[Helper] Error creando sesión:", e);
    dots.forEach((d) => setIndicador(d, "error"));
    return;
  }

  // ── Polling — detecta respuestas, justificaciones Y mensajes ──
  console.log("[Helper] Esperando respuestas... (polling cada 2s)");
  const currentAnswers = new Array(questions.length).fill(null);
  const currentJusts = new Array(questions.length).fill("");
  const currentGraficaCodes = new Array(questions.length).fill("");
  const currentMsgCounts = new Array(questions.length).fill(0);
  const currentAcciones = new Array(questions.length).fill(null);

  function renderMessages(chatMsgsEl, mensajes) {
    chatMsgsEl.innerHTML = "";
    mensajes.forEach((m) => {
      const bubble = document.createElement("div");
      const isMe = m.from === "client";
      bubble.style.cssText =
        "padding:2px 4px;margin:1px 0;border-radius:2px;font-size:9px;line-height:1.2;max-width:85%;word-break:break-word;" +
        (isMe
          ? "background:transparent;color:rgba(0,0,0,0.25);margin-left:auto;text-align:right;"
          : "background:transparent;color:rgba(0,0,0,0.3);margin-right:auto;");
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
          mensaje: { from: "client", text: text.trim() },
        }),
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
      bubble.style.cssText =
        "padding:2px 4px;margin:1px 0;border-radius:2px;font-size:9px;line-height:1.2;max-width:85%;word-break:break-word;background:transparent;color:rgba(0,0,0,0.25);margin-left:auto;text-align:right;";
      bubble.textContent = text;
      chatMsgs.appendChild(bubble);
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
      currentMsgCounts[i]++;
    };

    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        doSend();
      }
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
          console.log(
            "%c" +
              (currentAnswers[i] ? "🔄" : "✅") +
              " P" +
              (i + 1) +
              " → " +
              letra,
            "color:lime;font-weight:bold;",
          );
        }

        // Accion Dinamica (Genérica del Helper v2)
        const accion = data.accionesDinamicas?.[i] || null;
        if (
          accion &&
          JSON.stringify(accion) !== JSON.stringify(currentAcciones[i])
        ) {
          currentAcciones[i] = accion;
          try {
            const targetWrapper = questions[i].elemento;
            if (accion.type === "input") {
              const inputs = Array.from(
                targetWrapper.querySelectorAll(
                  "input[type=radio], input[type=checkbox]",
                ),
              );
              if (inputs[accion.idx]) {
                inputs[accion.idx].checked = accion.checked;
                // D2L often requires a click event to trigger save mechanism
                inputs[accion.idx].click();
              }
            } else if (accion.type === "select") {
              const selects = Array.from(
                targetWrapper.querySelectorAll("select"),
              );
              if (selects[accion.idx]) {
                selects[accion.idx].value = accion.value;
                selects[accion.idx].dispatchEvent(
                  new Event("change", { bubbles: true }),
                );
              }
            }
            setIndicador(dots[i], "done");
            console.log(
              "%c✓ P" +
                (i + 1) +
                " acción remota (" +
                accion.type +
                ") ejecutada",
              "color:lime;font-weight:bold;",
            );
          } catch (e) {
            console.warn(
              "[Helper] P" + (i + 1) + " Error ejecutando acción remota:",
              e,
            );
          }
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
                htmlContent +
                "</div>";
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

        // Gráfica nueva o cambió
        const graficaCode = data.graficaCodes?.[i] || "";
        if (graficaCode && graficaCode !== currentGraficaCodes[i]) {
          currentGraficaCodes[i] = graficaCode;
          // Mostrar indicador visual en el dot (color azul)
          // Si ya está en 'done', el azul de la gráfica tiene prioridad visual o se puede alternar
          // Aquí simplemente ponemos el estado 'graph'
          setIndicador(dots[i], "graph");
          console.log(
            "%c📊 P" + (i + 1) + " tiene gráfica guardada en helper",
            "color:#38bdf8;font-size:11px;",
          );
        }
      }
    } catch (e) {
      console.warn("[Helper] Error de polling:", e.message);
    }
  };

  // Poll indefinidamente (permite cambios de respuesta)
  setInterval(poll, 2000);
  poll(); // Primera ejecución inmediata

  console.log(
    "%c📌 X = toggle justificaciones | Z = toggle dots",
    "color:#94a3b8;font-size:11px;",
  );
})();
