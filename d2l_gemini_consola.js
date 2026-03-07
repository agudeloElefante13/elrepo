// ============================================================
//  D2L → Gemini Solver
// ============================================================

(async () => {

const GEMINI_API_KEY = "AIzaSyCFKJQVV8z54RdCIEPLyL-6iQ5wkO1kh20";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`;

// ── Utilidades DOM ───────────────────────────────────────────

function decodeHTMLEntities(str) {
  const txt = document.createElement("textarea");
  txt.innerHTML = str;
  return txt.value;
}

function htmlToText(html) {
  const decoded = decodeHTMLEntities(html);
  const div = document.createElement("div");
  div.innerHTML = decoded;
  return (div.textContent || div.innerText || "").trim().replace(/\s+/g, " ");
}

function extractImageSrc(blockElement) {
  const rendered = blockElement.querySelector("div.d2l-html-block-rendered");
  if (rendered) {
    const img = rendered.querySelector("img");
    if (img) return img.getAttribute("src");
  }
  const directImg = blockElement.querySelector("img");
  if (directImg) return directImg.getAttribute("src");
  const html = blockElement.getAttribute("html") || "";
  const div = document.createElement("div");
  div.innerHTML = decodeHTMLEntities(html);
  const img = div.querySelector("img");
  return img ? img.getAttribute("src") : null;
}

function getEnunciadoBlock(fieldset) {
  let ancestor = fieldset.parentElement;
  while (ancestor) {
    for (const block of ancestor.querySelectorAll("d2l-html-block")) {
      if (block.compareDocumentPosition(fieldset) & Node.DOCUMENT_POSITION_FOLLOWING) return block;
    }
    if (ancestor === document.body) break;
    ancestor = ancestor.parentElement;
  }
  return null;
}

// ── Imagen → base64 ──────────────────────────────────────────

async function fetchImageAsBase64(src) {
  const url = src.startsWith("http") ? src : window.location.origin + src;
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status} descargando imagen`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve({ base64: reader.result.split(",")[1], mimeType: blob.type || "image/png" });
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Llamada a Gemini ─────────────────────────────────────────

async function preguntarAGemini(enunciado, opciones, imagen) {
  const opcionesTexto = opciones.map(o => `${o.letra}) ${o.texto}`).join("\n");
  const prompt = `Eres un experto en matemáticas y ciencias. Analiza la siguiente pregunta y responde ÚNICAMENTE con la letra de la opción correcta (A, B, C o D). Sin explicación, sin punto, solo la letra.

Pregunta:
${enunciado}

Opciones:
${opcionesTexto}

Respuesta:`;

  const parts = [{ text: prompt }];
  if (imagen) parts.push({ inline_data: { mime_type: imagen.mimeType, data: imagen.base64 } });

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const responseParts = data.candidates?.[0]?.content?.parts ?? [];
  const raw = responseParts.map(p => p.text ?? "").join("").trim();
  if (!raw) throw new Error(`Gemini sin respuesta (finishReason: ${data.candidates?.[0]?.finishReason})`);
  const match = raw.toUpperCase().match(/[A-E]/);
  if (!match) throw new Error(`Respuesta inesperada: "${raw}"`);
  return match[0];
}

// ── Llamada a Gemini para justificación (segunda llamada) ────

async function pedirJustificacion(enunciado, opciones, letra) {
  const opcionesTexto = opciones.map(o => `${o.letra}) ${o.texto}`).join("\n");
  const mathJaxDisponible = !!(window.MathJax?.Hub || window.MathJax?.typesetPromise);

  const prompt = mathJaxDisponible
    ? `Eres un experto en matemáticas y ciencias. La respuesta correcta a la siguiente pregunta es la opción ${letra}.
Explica por qué es correcta mostrando todos los pasos numéricos clave usando notación LaTeX con \( \) para fórmulas y operaciones inline. Ejemplo: "\( v^2 = 22.22^2 - 2(1.0)(2) = 489.7 \), \( v = 22.13 \) m/s. Distancia \( = 489.7/10 = 48.97 \) m. Total \( = 50.97 \) m \( < 150 \) m." Sé conciso pero completo.

Pregunta:
${enunciado}

Opciones:
${opcionesTexto}

La respuesta correcta es: ${letra}`
    : `Eres un experto en matemáticas y ciencias. La respuesta correcta a la siguiente pregunta es la opción ${letra}.
Explica por qué es correcta en texto plano, mostrando las operaciones en línea con los valores numéricos sustituidos. Ejemplo: "v² = 22.22² - 2(1.0)(2) = 489.7, v = 22.13 m/s. Distancia = 489.7/10 = 48.97 m. Total = 50.97 m < 150 m." Sé conciso pero muestra todos los pasos numéricos clave.

Pregunta:
${enunciado}

Opciones:
${opcionesTexto}

La respuesta correcta es: ${letra}`;

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1024 },
    }),
  });

  if (!res.ok) return "";
  const data = await res.json();
  const responseParts = data.candidates?.[0]?.content?.parts ?? [];
  return responseParts.map(p => p.text ?? "").join("").trim();
}

// ── Seleccionar respuesta ────────────────────────────────────

function seleccionarRespuesta(fieldset, letra) {
  const idx = ["A","B","C","D","E"].indexOf(letra);
  if (idx === -1) return;
  const radio = fieldset.querySelectorAll("tr.d2l-rowshadeonhover")[idx]?.querySelector("input[type=radio]");
  if (radio) radio.click();
}

// ── UI discreta ──────────────────────────────────────────────

const todosIndicadores = [];
let indicadoresVisibles = true;

function toggleIndicadores() {
  indicadoresVisibles = !indicadoresVisibles;
  todosIndicadores.forEach(el => {
    el.style.display = indicadoresVisibles ? "block" : "none";
  });
}

// Toggle por click en enunciado — se agrega por pregunta en el main

function crearIndicador(fieldset) {
  const div = document.createElement("div");
  div.style.cssText = "margin-top:4px;margin-bottom:8px;font-size:10px;color:#aaa;font-family:monospace;user-select:none;opacity:0.6;";
  div.innerHTML = "⏳";
  fieldset.insertAdjacentElement("afterend", div);
  todosIndicadores.push(div);
  return div;
}

function mostrarRespuesta(indicador, letra, justificacion) {
  indicador.style.cssText = "margin-top:4px;margin-bottom:8px;font-size:10px;color:#888;font-family:sans-serif;user-select:none;opacity:0.55;border-left:2px solid #ccc;padding-left:6px;line-height:1.5;max-width:700px;white-space:pre-wrap;";
  indicador.innerHTML = `✓ <strong style="color:#555">${letra}</strong> &nbsp;—&nbsp; <span style="font-size:9px;white-space:normal;word-wrap:break-word;">${justificacion}</span>`;

  // Renderizar LaTeX con MathJax si está disponible
  try {
    if (window.MathJax?.Hub) MathJax.Hub.Queue(["Typeset", MathJax.Hub, indicador]);
    else if (window.MathJax?.typesetPromise) MathJax.typesetPromise([indicador]).catch(()=>{});
  } catch(e) {}
}

function mostrarError(indicador) {
  indicador.style.cssText = "margin-top:4px;font-size:10px;color:#e88;font-family:monospace;opacity:0.6;";
  indicador.innerHTML = "✗ error";
}

// ── Obtener documento correcto ───────────────────────────────

function obtenerDoc() {
  if (document.querySelectorAll("fieldset.dfs_m").length > 0) return document;
  try {
    const i1 = document.getElementById("ctl_2");
    if (!i1) return document;
    const d1 = i1.contentDocument;
    if (d1.querySelectorAll("fieldset.dfs_m").length > 0) { console.log("Usando: iframe ctl_2"); return d1; }
    const i2 = d1.querySelector("iframe[name='pageFrame']");
    if (i2?.contentDocument?.querySelectorAll("fieldset.dfs_m").length > 0) { console.log("Usando: iframe pageFrame"); return i2.contentDocument; }
  } catch(e) {}
  return document;
}

// ── Main ─────────────────────────────────────────────────────

console.clear();
console.log("=== D2L Gemini Solver ===\n");

const _doc = obtenerDoc();
const raiz = _doc.querySelector("div[style*='max-width:740px']") || _doc;
const fieldsets = raiz.querySelectorAll("fieldset.dfs_m");

if (fieldsets.length === 0) {
  console.warn("No se encontraron preguntas.");
} else {
  console.log(`Preguntas encontradas: ${fieldsets.length}\n`);
  const letras = ["A","B","C","D","E"];

  for (let i = 0; i < fieldsets.length; i++) {
    const fieldset = fieldsets[i];
    const num = i + 1;
    const indicador = crearIndicador(fieldset);

    try {
      const enunciadoBlock = getEnunciadoBlock(fieldset);
      if (!enunciadoBlock) throw new Error("No se encontró el enunciado");

      // Click en enunciado muestra/esconde el indicador de esa pregunta
      enunciadoBlock.style.cursor = "default";
      enunciadoBlock.addEventListener("click", () => {
        indicador.style.display = indicador.style.display === "none" ? "block" : "none";
      });

      const enunciado = htmlToText(enunciadoBlock.getAttribute("html") || "");

      let imagen = null;
      const imgSrc = extractImageSrc(enunciadoBlock);
      if (imgSrc) {
        console.log(`P${num}: descargando imagen...`);
        imagen = await fetchImageAsBase64(imgSrc);
      }

      const opciones = [];
      fieldset.querySelectorAll("tr.d2l-rowshadeonhover").forEach((row, idx) => {
        const block = row.querySelector("d2l-html-block");
        if (!block) return;
        opciones.push({ letra: letras[idx] ?? String(idx+1), texto: htmlToText(block.getAttribute("html") || "") });
      });

      console.log(`P${num}: consultando Gemini...`);
      const respuesta = await preguntarAGemini(enunciado, opciones, imagen);

      // Pedir justificación en paralelo (no bloquea el delay)
      const justificacion = await pedirJustificacion(enunciado, opciones, respuesta);
      mostrarRespuesta(indicador, respuesta, justificacion);

      console.log(`%c✅ Pregunta ${num} → ${respuesta}`, "font-size:14px; font-weight:bold; color:lime;");
      seleccionarRespuesta(fieldset, respuesta);

    } catch (err) {
      mostrarError(indicador);
      console.error(`❌ Pregunta ${num}: ${err.message}`);
    }
  }
  console.log("\n=== Listo ===");
}

})();
