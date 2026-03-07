// ============================================================
//  D2L → Gemini Solver (todo desde la consola)
//  Cambia la API key y pega en la consola del navegador
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

// ── Seleccionar respuesta ────────────────────────────────────

function seleccionarRespuesta(fieldset, letra) {
  const idx = ["A","B","C","D","E"].indexOf(letra);
  if (idx === -1) return;
  const radio = fieldset.querySelectorAll("tr.d2l-rowshadeonhover")[idx]?.querySelector("input[type=radio]");
  if (radio) radio.click();
}

// ── Obtener documento correcto ───────────────────────────────
// D2L puede tener las preguntas en 3 lugares distintos:
// 1. Directo en document
// 2. En iframe#ctl_2
// 3. En iframe#ctl_2 > iframe[name=pageFrame]

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
    try {
      const enunciadoBlock = getEnunciadoBlock(fieldset);
      if (!enunciadoBlock) throw new Error("No se encontró el enunciado");

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

      // Esperar entre 20 y 45 segundos antes de seleccionar (comportamiento humano)
      const espera = Math.floor(Math.random() * (45000 - 20000 + 1)) + 20000;
      console.log(`P${num}: esperando ${(espera/1000).toFixed(1)}s antes de responder...`);
      await new Promise(r => setTimeout(r, espera));

      console.log(`%c✅ Pregunta ${num} → ${respuesta}`, "font-size:14px; font-weight:bold; color:lime;");
      seleccionarRespuesta(fieldset, respuesta);

    } catch (err) {
      console.error(`❌ Pregunta ${num}: ${err.message}`);
    }
  }
  console.log("\n=== Listo ===");
}

})();
