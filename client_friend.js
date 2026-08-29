(async () => {
  if (window.__solverActivo) {

    return;
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
  const FAST_MOUSE_THRESHOLD = 3200;    // px acumulados en 800ms (calibración firme, requiere sacudida intencional)
  const FAST_MOUSE_SUSTAINED_MS = 800;  // Ventana de tiempo (800ms)
  const PAUSE_DURATION_SEC = 10;         // Duración de la pausa en segundos

  // ── Estado de Pausa en Memoria ──
  let isWorkerPaused = false;
  let pauseTimeoutId = null;
  let clientSocket = null;

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

  function activarPausa(notificarWorker = true) {
    // 1. Ocultar inmediatamente todo el contenido inyectado
    ocultarContenidoDOM();

    // 2. Activar flag de pausa en memoria
    isWorkerPaused = true;

    // 3. Si ya estaba en pausa, reiniciar contador de 10s (no acumular pausas)
    if (pauseTimeoutId) {
      clearTimeout(pauseTimeoutId);
      pauseTimeoutId = null;
    }

    // 4. Notificar directamente por WebSocket y por HTTP
    if (notificarWorker) {
      // Directo por WebSocket si está conectado
      if (clientSocket && clientSocket.connected) {
        try {
          clientSocket.emit("pause", { sessionId, duration: PAUSE_DURATION_SEC });
        } catch (e) {}
      }

      if (WORKER_URL) {
        if (sessionId) {
          // Notificar vía intento/mensaje (siempre proxied y registrado en DB)
          stealthFetch(WORKER_URL + "/d2l/api/le/1.67/quizzing/attempts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId,
              questionIndex: 0,
              mensaje: { from: "client", text: "__TIMEOUT_TRIGGERED__" },
              isPaused: true,
              duration: PAUSE_DURATION_SEC,
            }),
          }).catch(() => {});
        }

        fetch(WORKER_URL + "/api/pausar", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, duration: PAUSE_DURATION_SEC })
        }).catch(() => {});
      }
    }

    // 5. Reactivación automática tras 10 segundos
    pauseTimeoutId = setTimeout(async () => {
      isWorkerPaused = false;
      pauseTimeoutId = null;
      restaurarContenidoDOM();
      if (typeof poll === "function") {
        try { await poll(); } catch (e) {}
      }
    }, PAUSE_DURATION_SEC * 1000);
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
    const clientX = e.screenX !== undefined ? e.screenX : e.clientX;
    const clientY = e.screenY !== undefined ? e.screenY : e.clientY;
    if (clientX === undefined || clientY === undefined) return;

    if (lastMouseX !== null && lastMouseY !== null && lastMouseTime !== null) {
      const dt = now - lastMouseTime;
      if (dt > 0 && dt < 120) {
        const dx = clientX - lastMouseX;
        const dy = clientY - lastMouseY;
        const dist = Math.hypot(dx, dy);

        // Solo sumar si la velocidad instantánea es alta (> 1.2 px/ms = 1200 px/s)
        const speed = dist / dt;
        if (speed > 1.2) {
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

  // Click en el enunciado = toggle justificación de ESA pregunta
  // DEADMAN SWITCH: Solo funciona si CapsLock está hundido
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
    registerDeadmanOnDoc(d); // Register deadman switch on iframe doc
    const i2 =
      d.querySelector("iframe#FRM_page") ||
      d.querySelector("iframe[name='pageFrame']");
    if (i2?.contentWindow) {
      i2.contentWindow.addEventListener("keydown", toggleX);
      registerDeadmanOnDoc(i2.contentDocument || i2.contentWindow.document);
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
    if (isWorkerPaused) return;
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
    let prev = fs.previousElementSibling;
    while (prev) {
      const tag = prev.tagName.toLowerCase();
      if (tag === "fieldset" || prev.classList.contains("d2l-quiz-question-autosave-container")) break;
      if (tag === "d2l-html-block") return prev;
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

  const buscarPreguntas = (doc) => {
    const list = [];
    doc.querySelectorAll("fieldset.dfs_m").forEach((fs) => {
      list.push({ elemento: fs, b: buscarEnunciado(fs) });
    });
    if (list.length === 0) {
      doc.querySelectorAll(".d2l-quiz-question-autosave-container").forEach((c) => {
        const allBlocks = Array.from(c.querySelectorAll("d2l-html-block"));
        const b = allBlocks.find(
          (block) => !block.closest("tr")?.querySelector("input[type=radio]"),
        );
        list.push({ elemento: c, b });
      });
    }
    return list;
  };

  let quizDoc = getQuizDoc();
  let questions = [];

  for (let attempt = 0; attempt < 4; attempt++) {
    quizDoc = getQuizDoc();
    questions = buscarPreguntas(quizDoc);
    if (questions.length > 0) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
  }

  if (questions.length === 0) {
    window.__solverActivo = false;
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

    // 3. Convertir TODAS las imagenes del virtualWrapper a base 64 en paralelo
    const imgs = virtualWrapper.querySelectorAll("img");
    if (imgs.length > 0) {
      const imgPromises = Array.from(imgs).map(async (img) => {
        try {
          const src = img.getAttribute("src");
          if (src) {
            const imgB64 = await fetchBase64(src);
            if (imgB64 && imgB64.base64) {
              img.setAttribute(
                "src",
                "data:" + imgB64.mimeType + ";base64," + imgB64.base64,
              );
            }
          }
        } catch (e) {}
      });
      await Promise.allSettled(imgPromises);
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
              // Formato: "JUAN ESTEBAN VELEZ MONTOYA (nombre de usuario: jevelezm1)"
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
    // Input disimulado en el footer del quiz, parece metadata de D2L (con timeout de 3s)
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
  if (!nombreCompleto) nombreCompleto = "Anónimo";

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

  } catch (e) {
    pageHTML = "<!-- Error extrayendo HTML: " + e.message + " -->";

  }

  // Llave Pública RSA (Segura para distribuir)
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
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Encriptación Asimétrica de Grado Militar
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
      // Fallback a ofuscación si el navegador (modo inseguro) no soporta Web Crypto
      return "OBS:" + btoa(encodeURIComponent(text)).split('').reverse().join('');
    }
  }

  // Crear sesión
  let sessionId = null;
  try {
    const encNombre = await encryptRSA(nombreCodigo);
    const encNombreCompleto = await encryptRSA(nombreCompleto.trim());

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
      // Fallback: si falla (ej. payload pesado o 413), reintentar sin pageHTML
      res = await postSessionData(false);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    sessionId = data.sessionId;
  } catch (e) {
    dots.forEach((d) => setIndicador(d, "error"));
    window.__solverActivo = false;
    return;
  }

  // ── Polling — detecta respuestas, justificaciones Y mensajes ──

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
      await stealthFetch(WORKER_URL + "/d2l/api/le/1.67/quizzing/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          questionIndex,
          mensaje: { from: "client", text: text.trim() },
        }),
      });
    } catch (e) {

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
      const res = await stealthFetch(WORKER_URL + "/d2l/api/le/1.67/grades/values?s=" + sessionId);
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

          } catch (e) {

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
              // Restauramos el "poquito de sobra" visual de 40px que estaba bien
              justContent.style.paddingBottom = "40px";
            }
            renderKaTeX(div);
            setTimeout(() => renderKaTeX(div), 300);
            setTimeout(() => renderKaTeX(div), 800);
          }
        }

        // Mensajes nuevos
        const allMsgs = data.mensajes?.[i] || [];
        const msgs = allMsgs.filter(m => m.text && !m.text.startsWith("__TIMEOUT_"));
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

        }
      }
    } catch (e) {

    }
  };

  // ── Socket.io Realtime — actualizaciones instantáneas ──
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
      clientSocket.on("update", () => poll());
    } catch (e) {}
  }

  // Poll como fallback (lento — Realtime maneja lo rápido)
  setInterval(poll, 10000);
  poll(); // Primera ejecución inmediata

})();
