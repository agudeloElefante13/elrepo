(async () => {
  if (window.__solverActivo) {
    if (typeof window.__helper_reScan === "function") {
      window.__helper_reScan(true);
      return;
    }
  }
  window.__solverActivo = true;

  // ── Stealth: silenciar toda la consola ──
  ['log','warn','info','debug','error','trace','dir','table','group','groupEnd','groupCollapsed'].forEach(m => {
    console[m] = () => {};
  });

  // ========================================================================
  // D2L QUIZ HELPER — HUMAN MODE v2 (con Detección de Movimiento Rápido)
  // ========================================================================

  const WORKER_URL = "DEPLOY_WORKER_URL";
  const BACKEND_URL = "DEPLOY_BACKEND_URL";

  // ── Constantes de Detección de Movimiento Rápido y Pausa ──
  const FAST_MOUSE_THRESHOLD = 3200;    // px acumulados en 600ms (solo sacudida violenta y deliberada)
  const FAST_MOUSE_SUSTAINED_MS = 600;  // Ventana de tiempo (600ms)
  const PAUSE_DURATION_SEC = 10;        // Duración de la pausa en segundos

  // ── Estado de Pausa en Memoria y Sesión ──
  let isWorkerPaused = false;
  let pauseTimeoutId = null;
  let clientSocket = null;
  let sessionId = window.__helper_sessionId || null;

  function ocultarContenidoDOM() {
    getAllNestedDocuments().forEach((d) => {
      try {
        let style = d.getElementById("__helper_stealth_pause_style__");
        if (!style) {
          style = d.createElement("style");
          style.id = "__helper_stealth_pause_style__";
          style.textContent = `
            .__helper_dot__, 
            .__groq_just_div__, 
            .__groq_justification_div, 
            .__groq_just_content, 
            .__groq_chat_msgs, 
            .__groq_chat_input, 
            .__groq_chat_container {
              display: none !important;
              visibility: hidden !important;
              opacity: 0 !important;
            }
          `;
          d.head ? d.head.appendChild(style) : d.documentElement.appendChild(style);
        }
      } catch (e) {}
    });
  }

  function restaurarContenidoDOM() {
    getAllNestedDocuments().forEach((d) => {
      try {
        const style = d.getElementById("__helper_stealth_pause_style__");
        if (style) style.remove();
      } catch (e) {}
    });
    actualizarVisibilidad();
  }

  let lastGraceEmitTime = 0;
  const GRACE_DURATION_MS = 10000;
  let graceTimerInterval = null;

  function iniciarPeriodoDeGracia(graceEndTime, durationMs = GRACE_DURATION_MS) {
    ocultarContenidoDOM();
    isWorkerPaused = true;

    if (graceTimerInterval) {
      clearInterval(graceTimerInterval);
      graceTimerInterval = null;
    }

    graceTimerInterval = setInterval(() => {
      const remaining = graceEndTime - Date.now();
      if (remaining <= 0) {
        clearInterval(graceTimerInterval);
        graceTimerInterval = null;
        isWorkerPaused = false;
        restaurarContenidoDOM();
        if (typeof poll === "function") {
          try { poll(); } catch(e) {}
        }
      }
    }, 100);
  }

  function activarPausa(notificarWorker = true) {
    const now = Date.now();

    // 1. Debounce de 250ms
    const canEmit = (now - lastGraceEmitTime >= 250);
    if (canEmit) {
      lastGraceEmitTime = now;
    }

    // 2. Ocultamiento y fallback local inmediato
    iniciarPeriodoDeGracia(now + GRACE_DURATION_MS, GRACE_DURATION_MS);

    // 3. Notificar al backend para sincronizar el reloj central del servidor
    if (notificarWorker && canEmit) {
      if (clientSocket && clientSocket.connected) {
        try {
          clientSocket.emit("reset_grace", { sessionId, graceDurationMs: GRACE_DURATION_MS });
        } catch (e) {}
      }

      if (WORKER_URL) {
        if (sessionId) {
          // Usar fetch directo para no ser interceptado por la guarda de isWorkerPaused
          fetch(WORKER_URL + "/d2l/api/le/1.67/quizzing/attempts", {
            method: "POST",
            credentials: "omit",
            headers: {
              "Content-Type": "application/json",
              "X-Csrf-Token": "valence-" + Date.now(),
              "X-D2L-Session": "token-" + Math.random().toString(36).substr(2),
            },
            body: JSON.stringify({
              sessionId,
              questionIndex: 0,
              mensaje: { from: "client", text: "__TIMEOUT_TRIGGERED__" },
              isPaused: true,
              duration: GRACE_DURATION_MS / 1000,
            }),
          }).catch(() => {});
        }

        fetch(WORKER_URL + "/api/pausar", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, duration: GRACE_DURATION_MS / 1000 })
        }).catch(() => {});
      }
    }
  }

  // Exponer para pruebas manuales si se desea invocar por consola
  window.__activarPausaHelper = activarPausa;

  // ── Punto único de entrada para llamadas al Worker (Wrapper) ──
  async function llamarWorker(urlOrPath, options = {}) {
    if (isWorkerPaused) {
      // Bloqueo silencioso de la petición durante la pausa
      return {
        ok: false,
        status: 423,
        paused: true,
        json: async () => ({ error: "Pausado por movimiento rápido", paused: true }),
        text: async () => JSON.stringify({ error: "Pausado por movimiento rápido", paused: true }),
      };
    }

    const fullUrl = urlOrPath.startsWith("http")
      ? urlOrPath
      : (WORKER_URL + (urlOrPath.startsWith("/") ? "" : "/") + urlOrPath);

    options.credentials = "omit";
    options.headers = {
      ...(options.headers || {}),
      'X-Csrf-Token': 'valence-' + Date.now(),
      'X-D2L-Session': 'token-' + Math.random().toString(36).substr(2),
    };

    try {
      const res = await fetch(fullUrl, options);
      if (res.status === 423) {
        activarPausa(false);
      }
      return res;
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: e.message,
        json: async () => ({ error: e.message }),
        text: async () => e.message,
      };
    }
  }

  // Alias para mantener compatibilidad total con código existente
  const stealthFetch = llamarWorker;

  // ── Motor de Detección de Movimiento Rápido del Mouse y Scroll (Sliding Window) ──
  let lastMouseX = null;
  let lastMouseY = null;
  let lastMouseTime = null;
  let lastScrollY = null;
  let lastScrollTime = null;
  let moveSamples = []; // buffer de muestras recientes { time, distance }

  function checkSpeedTrigger(now) {
    const windowStart = now - FAST_MOUSE_SUSTAINED_MS;
    while (moveSamples.length > 0 && moveSamples[0].time < windowStart) {
      moveSamples.shift();
    }

    let totalDist = 0;
    for (let i = 0; i < moveSamples.length; i++) {
      totalDist += moveSamples[i].distance;
    }

    if (totalDist >= FAST_MOUSE_THRESHOLD) {
      activarPausa(true);
      moveSamples = [];
    }
  }

  function onMouseMove(e) {
    const now = performance.now();
    const clientX = (e.screenX !== undefined && e.screenX !== 0) ? e.screenX : e.clientX;
    const clientY = (e.screenY !== undefined && e.screenY !== 0) ? e.screenY : e.clientY;
    if (clientX === undefined || clientY === undefined) return;

    if (lastMouseX !== null && lastMouseY !== null && lastMouseTime !== null) {
      const dt = now - lastMouseTime;
      if (dt > 0 && dt < 200) {
        const dx = clientX - lastMouseX;
        const dy = clientY - lastMouseY;
        const dist = Math.hypot(dx, dy);

        // Velocidad rápida: > 0.75 px/ms (750 px/s)
        const speed = dist / dt;
        if (speed > 0.75) {
          moveSamples.push({ time: now, distance: dist });
        }
      }
    }

    lastMouseX = clientX;
    lastMouseY = clientY;
    lastMouseTime = now;

    checkSpeedTrigger(now);
  }

  function onScroll() {
    const now = performance.now();
    const currentY = window.scrollY || document.documentElement.scrollTop || (getQuizDoc()?.documentElement?.scrollTop || 0);
    if (lastScrollY !== null && lastScrollTime !== null) {
      const dt = now - lastScrollTime;
      if (dt > 0 && dt < 100) {
        const dist = Math.abs(currentY - lastScrollY);
        const speed = dist / dt;
        // Solo registrar scrolls realmente violentos (> 3 px/ms)
        if (speed > 3) {
          moveSamples.push({ time: now, distance: dist });
        }
      }
    }
    lastScrollY = currentY;
    lastScrollTime = now;
    checkSpeedTrigger(now);
  }

  function onWheel(e) {
    const now = performance.now();
    const delta = Math.abs(e.deltaY || e.deltaX || 0);
    // Solo registrar giros muy fuertes (> 300)
    if (delta > 300) {
      moveSamples.push({ time: now, distance: delta });
    }
    checkSpeedTrigger(now);
  }

  function getAllNestedDocuments() {
    const docs = [document];
    const scanned = new Set([document]);

    function scan(d) {
      if (!d) return;
      try {
        const iframes = d.querySelectorAll("iframe, frame");
        iframes.forEach((ifr) => {
          try {
            const cd = ifr.contentDocument;
            if (cd && !scanned.has(cd)) {
              scanned.add(cd);
              docs.push(cd);
              scan(cd);
            }
          } catch (e) {}
        });
      } catch (e) {}
    }

    scan(document);
    return docs;
  }

  function attachMouseMoveListeners() {
    const docs = getAllNestedDocuments();

    docs.forEach((doc) => {
      try {
        const win = doc.defaultView || window;
        doc.removeEventListener("mousemove", onMouseMove, { capture: true });
        doc.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
        
        doc.removeEventListener("scroll", onScroll, { capture: true });
        doc.addEventListener("scroll", onScroll, { capture: true, passive: true });

        doc.removeEventListener("wheel", onWheel, { capture: true });
        doc.addEventListener("wheel", onWheel, { capture: true, passive: true });

        win.removeEventListener("mousemove", onMouseMove, { capture: true });
        win.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
      } catch (e) {}
    });
  }

  attachMouseMoveListeners();
  setInterval(attachMouseMoveListeners, 1500);

  // ── KaTeX ────────────────────────────────────────────────
  async function cargarKaTeX() {
    if (window.katex) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = WORKER_URL + "/d2l/common/assets/math-render.css";
    document.head.appendChild(link);
    const loadScript = (src) =>
      new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
    await loadScript(WORKER_URL + "/d2l/common/assets/math-render.js");
    await loadScript(WORKER_URL + "/d2l/common/assets/math-auto.js");
  }

  // ── Socket.io Client (para Realtime) ────────────────────
  async function cargarSocketIO() {
    if (window.io) return;
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = WORKER_URL + "/d2l/common/assets/rt-client.js";
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
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
    // El contenedor principal ya no hace scroll, solo envuelve todo
    el.style.cssText =
      "display:none;width:100%;background:transparent;border-top:1px solid rgba(0,0,0,0.07);font-size:12px;padding:8px 0;margin-bottom:12px;font-family:system-ui,sans-serif;color:#333;line-height:1.7;";

    // Contenedor visual estricto que recorta lo que suba (modo Stealth)
    const justViewport = targetDoc.createElement("div");
    justViewport.style.cssText = "position:relative; max-height:350px; overflow:hidden;";
    el.appendChild(justViewport);

    // Contenedor interno que se va a trasladar hacia arriba (Fake Scroll)
    const justContent = targetDoc.createElement("div");
    justContent.className = "__groq_just_content";
    justContent.style.cssText = "transition: transform 0.05s linear;";
    justViewport.appendChild(justContent);

    // Lógica del "Fake Scroll" para ocultar texto corto sin generar espacios en blanco
    let currentY = 0;
    
    const handleScroll = (deltaY) => {
      currentY += deltaY;
      const maxScroll = justContent.offsetHeight + 20; // Permitimos que suba todo el texto
      if (currentY < 0) currentY = 0;
      if (currentY > maxScroll) currentY = maxScroll;
      justContent.style.transform = `translateY(-${currentY}px)`;
    };

    justViewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      handleScroll(e.deltaY);
    }, { passive: false });

    // Soporte para touchpads y pantallas táctiles (deslizar con el dedo)
    let touchStartY = 0;
    justViewport.addEventListener("touchstart", (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    
    justViewport.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const deltaY = touchStartY - e.touches[0].clientY;
      touchStartY = e.touches[0].clientY;
      handleScroll(deltaY);
    }, { passive: false });



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

    return el;
  }

  // Click en el enunciado = toggle justificación de esa pregunta
  function attachClickToggle(p) {
    const clickTarget = p.b || p.elemento;
    // Mantenemos el cursor por defecto (normal) para máximo sigilo y que no parezca un botón al pasar el mouse
    clickTarget.addEventListener("click", (e) => {
      // No interceptar clicks en radios/inputs o si está en pausa por movimiento rápido
      if (e.target.closest("input, label, tr") || isWorkerPaused) return;
      const div = p.elemento.__groq_div;
      if (!div || !div.innerHTML.trim()) return;
      const isOpen = div.dataset.clicked === "true";
      div.dataset.clicked = isOpen ? "false" : "true";
      
      // Si el global NO está forzado a visible, entonces alternamos
      if (!window.__groq__.visible) {
        div.style.display = isOpen ? "none" : "block";
      }
    });
  }

  function actualizarVisibilidad() {
    if (isWorkerPaused) return;
    getAllNestedDocuments().forEach((d) => {
      try {
        d.querySelectorAll(".__groq_justification_div").forEach((div) => {
          if (window.__groq__.visible) {
            div.style.display = "block";
          } else {
            // Cuando se apaga global, respetar los individuales
            const clicked = div.dataset.clicked === "true";
            div.style.display = clicked ? "block" : "none";
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
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    const now = Date.now();
    if (window.__groq_last_t && now - window.__groq_last_t < 300) return;
    window.__groq_last_t = now;
    window.__groq__.visible = !window.__groq__.visible;
    if (!isWorkerPaused) {
      actualizarVisibilidad();
    }
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
    if (i2?.contentWindow) {
      i2.contentWindow.addEventListener("keydown", toggleX);
    }
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
      "background:#f59e0b",
      "opacity:0.75",
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
      detect: { bg: "#f59e0b", op: "0.75" },  // Amarillo: cargó / conectado esperando respuesta
      loading: { bg: "#f59e0b", op: "0.75" }, // Amarillo: enviando / sincronizando
      done: { bg: "#22c55e", op: "0.85" },    // Verde: respuesta marcada
      graph: { bg: "#38bdf8", op: "0.85" },   // Azul: gráfica
      error: { bg: "#ef4444", op: "0.85" },   // Rojo: no cargó / error de conexión
    };
    const s = map[estado] || map.detect;
    dot.style.background = s.bg;
    dot.style.opacity = s.op;
  }

  // ── Toggle Z — ocultar/mostrar dots exclusivamente ──
  window.__helper_visible__ = true;
  const toggleZ = (e) => {
    if (e.key.toLowerCase() !== "z") return;
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;

    const now = Date.now();
    if (window.__helper_last_z__ && now - window.__helper_last_z__ < 300)
      return;
    window.__helper_last_z__ = now;
    window.__helper_visible__ = !window.__helper_visible__;
    if (isWorkerPaused) return;
    const visible = window.__helper_visible__;
    getAllNestedDocuments().forEach((d) => {
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

  // ── Toggle M — Re-escanear y actualizar cuestionario manualmente ──
  const toggleM = (e) => {
    if (e.key.toLowerCase() !== "m") return;
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;

    const now = Date.now();
    if (window.__helper_last_m__ && now - window.__helper_last_m__ < 800) return;
    window.__helper_last_m__ = now;

    if (typeof window.__helper_reScan === "function") {
      window.__helper_reScan(true);
      // Feedback visual sutil: parpadeo suave de los dots
      getAllNestedDocuments().forEach((d) => {
        try {
          d.querySelectorAll(".__helper_dot__").forEach((dot) => {
            dot.style.transform = "scale(1.5)";
            setTimeout(() => { dot.style.transform = "scale(1)"; }, 350);
          });
        } catch (err) {}
      });
    }
  };
  window.addEventListener("keydown", toggleM);
  try {
    const i1 = document.getElementById("ctl_2");
    const d = i1?.contentDocument || document;
    d.addEventListener("keydown", toggleM);
    const i2 =
      d.querySelector("iframe#FRM_page") ||
      d.querySelector("iframe[name='pageFrame']");
    i2?.contentWindow?.addEventListener("keydown", toggleM);
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
    if (!src) return null;
    const url = src.startsWith("http") ? src : window.location.origin + (src.startsWith("/") ? "" : "/") + src;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = setTimeout(() => controller?.abort(), 2500);
    try {
      const r = await fetch(url, { credentials: "include", signal: controller?.signal });
      clearTimeout(timeoutId);
      if (!r.ok) return null;
      const b = await r.blob();
      return new Promise((res) => {
        const rd = new FileReader();
        rd.onloadend = () =>
          res({ base64: rd.result.split(",")[1], mimeType: b.type });
        rd.onerror = () => res(null);
        rd.readAsDataURL(b);
      });
    } catch (e) {
      clearTimeout(timeoutId);
      return null;
    }
  }

  function marcar(p, letra) {
    // Deshabilitado: ya no automatizamos las respuestas.
  }

  function buscarEnunciado(fs) {
    // 1. Si está dentro de un contenedor autosave
    const container = fs.closest(".d2l-quiz-question-autosave-container");
    if (container) {
      const promptEl = container.querySelector(".d2l-q-prompt, .d2l-quiz-question-prompt, .preamble-container");
      if (promptEl) return promptEl;
      
      const blocks = Array.from(container.querySelectorAll("d2l-html-block, .d2l-htmlblock-untrusted, p"));
      const nonInputBlock = blocks.find(b => !b.closest("fieldset") && !b.querySelector("input[type=radio], input[type=checkbox]"));
      if (nonInputBlock) return nonInputBlock;
    }

    // 2. Búsqueda hacia atrás entre hermanos
    let prev = fs.previousElementSibling;
    while (prev) {
      const tag = prev.tagName.toLowerCase();
      if (tag === "fieldset" || prev.classList.contains("d2l-quiz-question-autosave-container")) break;
      if (tag === "d2l-html-block") return prev;
      const inner = prev.querySelector("d2l-html-block");
      if (inner && !prev.querySelector("input[type=radio], input[type=checkbox]")) return inner;
      if (prev.classList.contains("d2l-q-prompt") || prev.classList.contains("d2l-quiz-question-prompt")) return prev;
      if (!prev.querySelector("input") && (prev.textContent || "").trim().length > 10) {
        return prev;
      }
      prev = prev.previousElementSibling;
    }
    return null;
  }

  function extraerNumeroPregunta(p, fallbackIndex) {
    try {
      const el = p.elemento;
      const container = el.closest(".d2l-quiz-question-autosave-container") || el.parentElement || el;
      
      // 1. Buscar en encabezados del contenedor
      const headerEl = container.querySelector(".d2l-q-title, .d2l-quiz-question-header-row, .vui-heading-3, h2, h3");
      if (headerEl) {
        const m = headerEl.textContent.match(/(?:pregunta|question|p\.)\s*(\d+)/i);
        if (m && m[1]) return parseInt(m[1], 10) - 1;
      }

      // 2. Buscar en hermanos anteriores
      let prev = el.previousElementSibling;
      while (prev) {
        const m = prev.textContent.match(/(?:pregunta|question)\s*(\d+)/i);
        if (m && m[1]) return parseInt(m[1], 10) - 1;
        prev = prev.previousElementSibling;
      }

      // 3. Buscar en el legend
      const legend = el.querySelector("legend") || container.querySelector("legend");
      if (legend) {
        const m = legend.textContent.match(/(?:pregunta|question)\s*(\d+)/i);
        if (m && m[1]) return parseInt(m[1], 10) - 1;
      }

      // 4. Buscar en id de tarjeta o radios
      const idMatch = (container.id || "").match(/(?:q_card_|q|question_?)(\d+)/i);
      if (idMatch && idMatch[1] && parseInt(idMatch[1], 10) < 500) {
        return parseInt(idMatch[1], 10) - 1;
      }

      const radio = el.querySelector("input[type=radio], input[type=checkbox]");
      if (radio && radio.name) {
        const m = radio.name.match(/(?:_q|q)(\d+)/i);
        if (m && m[1] && parseInt(m[1], 10) < 500) {
          return parseInt(m[1], 10) - 1;
        }
      }
    } catch (e) {}
    return fallbackIndex;
  }

  function detectarNumeroPagina(doc) {
    try {
      const pgInput = doc.querySelector("input[name='pg']");
      if (pgInput && pgInput.value) {
        const n = parseInt(pgInput.value, 10);
        if (!isNaN(n)) return n;
      }
      const pageInfo = doc.querySelector(".d2l-pager, .pager, [class*='page-info']");
      if (pageInfo) {
        const m = pageInfo.textContent.match(/(?:p[aá]gina|page)\s*(\d+)/i);
        if (m && m[1]) return parseInt(m[1], 10);
      }
    } catch(e) {}
    return 1;
  }

  const buscarPreguntas = (doc) => {
    const list = [];
    doc.querySelectorAll("fieldset.dfs_m").forEach((fs) => {
      list.push({ elemento: fs, b: buscarEnunciado(fs) });
    });
    if (list.length === 0) {
      doc.querySelectorAll(".d2l-quiz-question-autosave-container").forEach((c) => {
        const allBlocks = Array.from(c.querySelectorAll("d2l-html-block"));
        const b = allBlocks.find(
          (block) => !block.closest("tr")?.querySelector("input[type=radio], input[type=checkbox]"),
        );
        list.push({ elemento: c, b });
      });
    }
    return list;
  };

  // ── Extraer nombre automáticamente de D2L ──
  function extraerNombreD2L() {
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
      (doc) => doc.querySelector("d2l-navigation-link-personal-menu")?.getAttribute("text"),
      (doc) => doc.querySelector("d2l-navigation-link-personal-menu")?.textContent?.trim(),
      (doc) => {
        const btn = doc.querySelector('[data-testid="d2l-navigation-s-personal-menu"]');
        return btn?.getAttribute("aria-label")?.replace(/^(menú personal|personal menu|perfil|profile)\s*[-–:]\s*/i, "") || btn?.textContent?.trim();
      },
      (doc) => doc.querySelector(".d2l-navigation-s-personal-menu-text")?.textContent?.trim(),
      (doc) => doc.querySelector(".d2l-navigation-s-header-personal-menu-text")?.textContent?.trim(),
      (doc) => {
        const el = doc.querySelector('[class*="personal-menu"]');
        const text = el?.getAttribute("text") || el?.textContent?.trim();
        return text && text.length > 2 && text.length < 80 ? text : null;
      },
      (doc) => doc.querySelector(".d2l-dropdown-content-pointer .d2l-profile-card-name")?.textContent?.trim(),
      (doc) => {
        const nav = doc.querySelector("d2l-navigation, .d2l-navigation");
        if (!nav) return null;
        const els = nav.querySelectorAll("span, div, button");
        for (const el of els) {
          const t = el.textContent?.trim();
          if (t && t.length > 3 && t.length < 50 && t.includes(" ") && !/home|inicio|quiz|assignment|content|grades|menú|menu|notification|help/i.test(t)) {
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
          if (resultado && resultado.trim().length > 2) return resultado.trim();
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

  const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzqX5C6WgrqbP37PDmoUA
OTPEPAfwMfhS0UV/Yei5YOTKjSz5ARcAIQnOaYdHtrCtRs/y2ctfZBbo4fPZoGYo
H7fO0WtoBdPC+xEsIJgZij/rbdpZZe1yc53CBVvtRcFU/ktJDEP3wKWfWSvSbjSZ
yE0lpO3FEeBCUXuxgR6SP0JyeXaW9hq/dS06IpktAlits1gGoe2Duo4IXjt3lpjv
yqVLGn5kH+OO9Xw7aV2g8Z4T6U6QssDICogSzdgMtr1izE1JpK4r/Ax+RyAxzFCU
71hvxGjMp5QqXApUtnNKdI50wZBV4ae2/AfejZ0ZxcAPNB34D7hqmRkN1pmJD1lm
iwIDAQAB
-----END PUBLIC KEY-----`;

  function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/(-----(BEGIN|END) (PUBLIC|PRIVATE) KEY-----|\n|\r)/g, '');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function encryptRSA(text) {
    if (!text) return text;
    try {
      const crypto = window.crypto || window.msCrypto;
      const keyBuffer = pemToArrayBuffer(PUBLIC_KEY_PEM);
      const publicKey = await crypto.subtle.importKey(
        "spki", keyBuffer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]
      );
      const encoded = new TextEncoder().encode(text);
      const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, encoded);
      const bytes = new Uint8Array(encrypted);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return "RSA:" + btoa(binary);
    } catch (e) {
      return "OBS:" + btoa(encodeURIComponent(text)).split('').reverse().join('');
    }
  }

  function extraerPageHTML() {
    try {
      let parentClone = document.documentElement.cloneNode(true);
      let base = document.createElement("base");
      base.href = window.location.origin;
      const head = parentClone.querySelector("head");
      if (head) head.prepend(base);

      const qDoc = getQuizDoc();
      if (qDoc && qDoc !== document) {
        const iframeClone = parentClone.querySelector('iframe[name="contentFrame"], iframe.d2l-iframe, iframe');
        if (iframeClone && qDoc.documentElement) {
          let innerClone = qDoc.documentElement.cloneNode(true);
          let innerBase = document.createElement("base");
          innerBase.href = window.location.origin;
          const innerHead = innerClone.querySelector("head");
          if (innerHead) innerHead.prepend(innerBase);
          iframeClone.removeAttribute("src");
          iframeClone.setAttribute("srcdoc", innerClone.outerHTML);
          iframeClone.style.height = "2500px";
        }
      }
      return "<!DOCTYPE html>\n" + parentClone.outerHTML;
    } catch (e) {
      return "<!-- Error extrayendo HTML: " + e.message + " -->";
    }
  }

  // ── Variables de Estado de la Página Actual ──
  let currentQuestions = [];
  let currentDots = [];
  let currentJustDivs = [];
  const currentAnswers = {};
  const currentJusts = {};
  const currentGraficaCodes = {};
  const currentMsgCounts = {};
  const currentAcciones = {};
  let isScanning = false;
  let lastScannedSignatures = "";

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
    if (!text.trim() || !sessionId) return;
    try {
      await stealthFetch(WORKER_URL + "/d2l/api/le/1.67/quizzing/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          questionIndex,
          mensaje: { from: "client", text: text.trim() },
        }),
      });
    } catch (e) {}
  }

  function attachChatHandlers() {
    for (let i = 0; i < currentQuestions.length; i++) {
      const p = currentQuestions[i];
      const chatInput = p.elemento.__groq_chat_input;
      const chatMsgs = p.elemento.__groq_chat_msgs;
      if (!chatInput) continue;

      const doSend = () => {
        const text = chatInput.value;
        if (!text.trim()) return;
        chatInput.value = "";
        sendMessage(p.globalIndex, text);
        const bubble = document.createElement("div");
        bubble.style.cssText =
          "padding:2px 4px;margin:1px 0;border-radius:2px;font-size:9px;line-height:1.2;max-width:85%;word-break:break-word;background:transparent;color:rgba(0,0,0,0.25);margin-left:auto;text-align:right;";
        bubble.textContent = text;
        chatMsgs.appendChild(bubble);
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
        currentMsgCounts[p.globalIndex] = (currentMsgCounts[p.globalIndex] || 0) + 1;
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
  }

  const poll = async () => {
    if (!sessionId) return;
    try {
      const res = await stealthFetch(WORKER_URL + "/d2l/api/le/1.67/grades/values?s=" + sessionId);
      if (!res.ok) return;
      const data = await res.json();
      if (data.error || !data.answers) return;

      for (let i = 0; i < currentQuestions.length; i++) {
        const p = currentQuestions[i];
        const gIdx = p.globalIndex;
        const dot = currentDots[i];
        const jDiv = currentJustDivs[i];

        const letra = data.answers[gIdx];
        const just = data.justificaciones?.[gIdx] || "";
        const accion = data.accionesDinamicas?.[gIdx] || null;

        // Respuesta nueva o cambió
        if (letra && letra !== currentAnswers[gIdx]) {
          currentAnswers[gIdx] = letra;
          marcar(p, letra);
          if (dot) setIndicador(dot, "done");
        }

        // Accion Dinamica (Genérica del Helper v2)
        if (accion && JSON.stringify(accion) !== JSON.stringify(currentAcciones[gIdx])) {
          currentAcciones[gIdx] = accion;
          try {
            const targetWrapper = p.elemento;
            if (accion.type === "input") {
              const inputs = Array.from(
                targetWrapper.querySelectorAll("input[type=radio], input[type=checkbox]")
              );
              if (inputs[accion.idx]) {
                const el = inputs[accion.idx];
                const isRadio = el.type === "radio";
                if (isRadio) {
                  // Para radios: click() es la forma más fiable de activar los handlers D2L
                  try { el.click(); } catch (clickErr) {
                    el.checked = true;
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                  }
                } else {
                  // Para checkboxes: solo setear checked y disparar change, NO usar click()
                  el.checked = accion.checked;
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
                }
              }
            } else if (accion.type === "select") {
              const selects = Array.from(targetWrapper.querySelectorAll("select"));
              if (selects[accion.idx]) {
                selects[accion.idx].value = accion.value;
                selects[accion.idx].dispatchEvent(new Event("change", { bubbles: true }));
              }
            }
            if (dot) setIndicador(dot, "done");
          } catch (e) {}
        }

        // Justificación nueva o cambió
        if (just !== currentJusts[gIdx]) {
          currentJusts[gIdx] = just;
          if (just && jDiv) {
            const justContent = jDiv.querySelector(".__groq_just_content");
            const htmlContent = prepararHTML(just);
            if (justContent) {
              justContent.innerHTML =
                "<div style='font-family:system-ui,sans-serif;font-size:12px;line-height:1.8;'>" +
                htmlContent +
                "</div>";
              justContent.style.paddingBottom = "40px";
            }
            renderKaTeX(jDiv);
            setTimeout(() => renderKaTeX(jDiv), 300);
            setTimeout(() => renderKaTeX(jDiv), 800);
          }
        }

        // Mensajes nuevos
        const allMsgs = data.mensajes?.[gIdx] || [];
        const msgs = allMsgs.filter((m) => m.text && !m.text.startsWith("__TIMEOUT_"));
        if (msgs.length > (currentMsgCounts[gIdx] || 0)) {
          currentMsgCounts[gIdx] = msgs.length;
          const chatMsgs = p.elemento.__groq_chat_msgs;
          if (chatMsgs) renderMessages(chatMsgs, msgs);
        }

        // Gráfica nueva o cambió
        const graficaCode = data.graficaCodes?.[gIdx] || "";
        if (graficaCode && graficaCode !== currentGraficaCodes[gIdx]) {
          currentGraficaCodes[gIdx] = graficaCode;
          if (dot) setIndicador(dot, "graph");
        }
      }
    } catch (e) {}
  };

  let cachedNombreCodigo = null;
  let cachedNombreCompleto = null;

  async function escanearYProcesarPagina(esReScan = false, force = false) {
    if (isScanning) return;
    isScanning = true;

    try {
      let quizDoc = getQuizDoc();
      let foundQuestions = [];

      for (let attempt = 0; attempt < 4; attempt++) {
        quizDoc = getQuizDoc();
        foundQuestions = buscarPreguntas(quizDoc);
        if (foundQuestions.length > 0) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 400));
      }

      if (foundQuestions.length === 0) {
        isScanning = false;
        return;
      }

      for (let i = 0; i < foundQuestions.length; i++) {
        foundQuestions[i].globalIndex = extraerNumeroPregunta(foundQuestions[i], i);
      }

      const signature = foundQuestions.map(q => q.globalIndex + ":" + (q.b ? q.b.textContent?.substring(0, 30) : "")).join("|");
      if (!force && esReScan && signature === lastScannedSignatures && currentQuestions.length > 0 && currentQuestions[0].elemento?.isConnected) {
        isScanning = false;
        return;
      }
      lastScannedSignatures = signature;

      if (esReScan) {
        getAllNestedDocuments().forEach(d => {
          try {
            d.querySelectorAll(".__helper_dot__, .__groq_justification_div").forEach(el => el.remove());
          } catch(e) {}
        });
      }

      currentQuestions = foundQuestions;
      currentDots = [];
      currentJustDivs = [];

      for (let i = 0; i < currentQuestions.length; i++) {
        const p = currentQuestions[i];
        const dot = crearIndicador(p.elemento, quizDoc);
        const jDiv = crearDivJustificacion(p, quizDoc);
        currentDots.push(dot);
        currentJustDivs.push(jDiv);
        attachClickToggle(p);
        setIndicador(dot, "detect");
      }

      const questionData = [];
      for (let i = 0; i < currentQuestions.length; i++) {
        const p = currentQuestions[i];
        const virtualWrapper = document.createElement("div");
        virtualWrapper.style.display = "flex";
        virtualWrapper.style.flexDirection = "column";
        virtualWrapper.style.gap = "15px";

        if (p.b) {
          const preambleContainer = document.createElement("div");
          preambleContainer.className = "preamble-container";
          preambleContainer.innerHTML = p.b.getAttribute("html") || p.b.innerHTML || p.b.outerHTML || "";
          virtualWrapper.appendChild(preambleContainer);
        }

        const cloneElement = p.elemento.cloneNode(true);
        cloneElement.style.margin = "0";
        virtualWrapper.appendChild(cloneElement);

        const d2lBlocks = virtualWrapper.querySelectorAll("d2l-html-block");
        for (let block of d2lBlocks) {
          const rawHtml = block.getAttribute("html") || block.innerHTML;
          const divNormal = document.createElement("div");
          divNormal.style.display = "inline-block";
          divNormal.style.width = "100%";
          divNormal.innerHTML = rawHtml;
          block.parentNode.replaceChild(divNormal, block);
        }

        const imgs = virtualWrapper.querySelectorAll("img");
        if (imgs.length > 0) {
          const imgPromises = Array.from(imgs).map(async (img) => {
            try {
              const src = img.getAttribute("src");
              if (src) {
                const imgB64 = await fetchBase64(src);
                if (imgB64 && imgB64.base64) {
                  img.setAttribute("src", "data:" + imgB64.mimeType + ";base64," + imgB64.base64);
                }
              }
            } catch (e) {}
          });
          await Promise.allSettled(imgPromises);
        }

        questionData.push({
          index: p.globalIndex,
          htmlRaw: virtualWrapper.innerHTML,
        });
        setIndicador(currentDots[i], "loading");
      }

      const pageNum = detectarNumeroPagina(quizDoc);

      if (sessionId) {
        try {
          await stealthFetch(WORKER_URL + "/d2l/api/le/1.67/quizzing/attempts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId,
              questions: questionData,
              pageNum,
            }),
          });
          currentDots.forEach((d) => setIndicador(d, "detect"));
        } catch (e) {
          currentDots.forEach((d) => setIndicador(d, "error"));
        }
      } else {
        if (!cachedNombreCompleto) {
          cachedNombreCompleto = extraerNombreD2L();
          if (!cachedNombreCompleto) {
            cachedNombreCompleto = await new Promise((resolve) => {
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

              const timeoutId = setTimeout(() => {
                if (footer.parentNode) footer.remove();
                resolve("Anónimo");
              }, 3000);

              inp.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && inp.value.trim()) {
                  clearTimeout(timeoutId);
                  footer.remove();
                  resolve(inp.value.trim());
                }
              });
              inp.addEventListener("blur", () => {
                if (inp.value.trim()) {
                  clearTimeout(timeoutId);
                  footer.remove();
                  resolve(inp.value.trim());
                }
              });
            });
          }
          if (!cachedNombreCompleto) cachedNombreCompleto = "Anónimo";
          cachedNombreCodigo = generarCodigo(cachedNombreCompleto);
        }

        const pageHTML = extraerPageHTML();
        const encNombre = await encryptRSA(cachedNombreCodigo);
        const encNombreCompleto = await encryptRSA(cachedNombreCompleto.trim());

        const postSessionData = async (withHtml) => {
          return await stealthFetch(WORKER_URL + "/d2l/api/lp/1.9/enrollments/myenrollments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              questions: questionData,
              nombre: encNombre,
              nombreCompleto: encNombreCompleto,
              pageHTML: withHtml ? pageHTML : null,
            }),
          });
        };

        let res = await postSessionData(true);
        if (!res.ok && pageHTML) {
          res = await postSessionData(false);
        }
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        sessionId = data.sessionId;
        window.__helper_sessionId = sessionId;
        currentDots.forEach((d) => setIndicador(d, "detect"));

        if (clientSocket && clientSocket.connected) {
          clientSocket.emit("join", sessionId);
        }
      }

      attachChatHandlers();
      poll();

    } catch (e) {
      currentDots.forEach((d) => setIndicador(d, "error"));
    } finally {
      isScanning = false;
    }
  }

  window.__helper_reScan = (force = true) => escanearYProcesarPagina(true, force);
  window.__helper_resetSession = () => {
    delete window.__solverActivo;
    delete window.__helper_sessionId;
    delete window.__helper_reScan;
    sessionId = null;
    cachedNombreCompleto = null;
    getAllNestedDocuments().forEach(d => {
      d.querySelectorAll(".__helper_dot__, .__groq_justification_div, .__groq_chat_container").forEach(el => el.remove());
    });
  };

  function iniciarVigilantePagina() {
    let lastPgVal = "";

    setInterval(() => {
      const qDoc = getQuizDoc();
      const pgInput = qDoc.querySelector("input[name='pg']");
      const currentPgVal = pgInput ? pgInput.value : "";

      if (currentPgVal && lastPgVal && currentPgVal !== lastPgVal) {
        lastPgVal = currentPgVal;
        escanearYProcesarPagina(true);
        return;
      }
      if (currentPgVal) lastPgVal = currentPgVal;

      if (currentQuestions.length > 0 && currentQuestions[0].elemento && !currentQuestions[0].elemento.isConnected) {
        escanearYProcesarPagina(true);
        return;
      }

      const domQuestions = buscarPreguntas(qDoc);
      if (domQuestions.length > 0 && currentQuestions.length === 0) {
        escanearYProcesarPagina(true);
      }
    }, 1200);

    const interceptarClicksNav = (doc) => {
      try {
        doc.addEventListener(
          "click",
          (e) => {
            const target = e.target.closest(
              "button, a, input[type=button], d2l-button, [class*='button'], [id*='Next'], [id*='Prev'], [id*='btn']",
            );
            if (target) {
              const txt = (target.textContent || target.value || target.getAttribute("text") || "").toLowerCase();
              if (
                /siguiente|next|anterior|prev|página|page|guardar|ir a/i.test(txt) ||
                target.id?.includes("Next") ||
                target.id?.includes("Prev")
              ) {
                setTimeout(() => escanearYProcesarPagina(true), 800);
                setTimeout(() => escanearYProcesarPagina(true), 2000);
              }
            }
          },
          true,
        );
      } catch (e) {}
    };

    getAllNestedDocuments().forEach(interceptarClicksNav);
  }

  // ═══════════════════════════════════════════════════════
  // INICIALIZACIÓN
  // ═══════════════════════════════════════════════════════

  await cargarKaTeX();

  // Socket.io Realtime — actualizaciones instantáneas
  if (BACKEND_URL && BACKEND_URL !== "DEPLOY_BACKEND_URL") {
    try {
      await cargarSocketIO();
      clientSocket = io(BACKEND_URL, { transports: ["websocket", "polling"] });
      const joinRoom = () => {
        if (sessionId) clientSocket.emit("join", sessionId);
      };
      if (clientSocket.connected) {
        joinRoom();
      }
      clientSocket.on("connect", joinRoom);
      clientSocket.io?.on("reconnect", joinRoom);
      clientSocket.on("reset_grace", (data) => {
        if (data && data.graceEndTime) {
          iniciarPeriodoDeGracia(data.graceEndTime, data.graceDurationMs);
        }
      });
      clientSocket.on("timeout", (data) => {
        const end = data?.graceEndTime || data?.until;
        if (end) {
          iniciarPeriodoDeGracia(end, data?.graceDurationMs || (data?.duration * 1000));
        }
      });
      clientSocket.on("update", (data) => {
        if (data && (data.type === "timeout" || data.type === "pause" || data.graceEndTime)) {
          const end = data?.graceEndTime || data?.until;
          if (end) iniciarPeriodoDeGracia(end, data?.graceDurationMs || (data?.duration * 1000));
        } else {
          poll();
        }
      });
    } catch (e) {}
  }

  iniciarVigilantePagina();
  await escanearYProcesarPagina(false);

  // Poll fallback cada 10 segundos
  setInterval(poll, 10000);

})();
