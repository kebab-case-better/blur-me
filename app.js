'use strict';
// Tout le traitement se fait dans le navigateur : aucun fichier n'est envoyé.

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const srcVideo = $('src');
const tmp = document.createElement('canvas');
const tmpCtx = tmp.getContext('2d');

let ready = false;
let mode = null;        // 'photo' | 'video'
let photo = null;       // ImageBitmap ou <img>
let zones = [];         // photo : {x, y, w, h, on, manual}
let fileName = 'fichier';
let job = null;         // traitement vidéo en cours
let resultUrl = null;

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

const settings = () => ({
  style: $('style').value,
  strength: +$('strength').value / 100,
  margin: +$('margin').value / 100,
  minConfidence: 0.75 - (+$('sens').value / 100) * 0.6, // 0.75 (strict) → 0.15 (large)
});

// ---------- Détection ----------

async function detect(input, minConfidence) {
  const options = new faceapi.SsdMobilenetv1Options({ minConfidence, maxResults: 100 });
  const found = await faceapi.detectAllFaces(input, options);
  return found.map((d) => ({ x: d.box.x, y: d.box.y, w: d.box.width, h: d.box.height }));
}

function iou(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

// Sur les grandes photos, on repasse le détecteur sur des tuiles qui se
// chevauchent pour attraper les petits visages (foules, arrière-plans).
async function detectPhoto(image, minConfidence) {
  const W = image.width, H = image.height;
  const all = await detect(imageToCanvas(image, 0, 0, W, H), minConfidence);
  if (Math.max(W, H) > 1000) {
    const n = Math.max(W, H) > 3000 ? 3 : 2;
    const tw = W / n * 1.3, th = H / n * 1.3;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const tx = Math.min(W - tw, Math.max(0, (W / n) * i - tw * 0.115));
      const ty = Math.min(H - th, Math.max(0, (H / n) * j - th * 0.115));
      const boxes = await detect(imageToCanvas(image, tx, ty, tw, th), minConfidence);
      for (const b of boxes) {
        const box = { x: b.x + tx, y: b.y + ty, w: b.w, h: b.h };
        if (!all.some((a) => iou(a, box) > 0.3)) all.push(box);
      }
    }
  }
  return all;
}

function imageToCanvas(image, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w); c.height = Math.round(h);
  c.getContext('2d').drawImage(image, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

// ---------- Masquage ----------

function hide(box, s, manual = false) {
  const m = manual ? 0 : s.margin;
  let x = box.x - box.w * m / 2, y = box.y - box.h * m / 2;
  let w = box.w * (1 + m), h = box.h * (1 + m);
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(canvas.width - x, w); h = Math.min(canvas.height - y, h);
  if (w < 2 || h < 2) return;

  if (s.style === 'black') {
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, w, h);
    return;
  }
  // On réduit la zone à quelques pixels puis on la ré-agrandit : le détail
  // d'origine est réellement détruit (contrairement à un simple filtre léger).
  const cells = Math.round(14 - s.strength * 11); // 14 → 3 blocs sur le grand côté
  const k = cells / Math.max(w, h);
  tmp.width = Math.max(1, Math.round(w * k));
  tmp.height = Math.max(1, Math.round(h * k));
  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.drawImage(canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
  ctx.save();
  if (s.style === 'blur' && !manual) {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.imageSmoothingEnabled = s.style === 'blur';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
  ctx.restore();
}

// ---------- Photo ----------

function renderPhoto(outlines = true, draft = null) {
  const s = settings();
  ctx.drawImage(photo, 0, 0);
  for (const z of zones) if (z.on) hide(z, s, z.manual);
  if (!outlines) return;
  const lw = Math.max(2, canvas.width / 400);
  ctx.lineWidth = lw;
  for (const z of zones) {
    if (z.on) continue;
    ctx.setLineDash([lw * 3, lw * 3]);
    ctx.strokeStyle = '#ff5a36';
    ctx.strokeRect(z.x, z.y, z.w, z.h);
  }
  if (draft) {
    ctx.setLineDash([]);
    ctx.strokeStyle = '#36c5ff';
    ctx.strokeRect(draft.x, draft.y, draft.w, draft.h);
  }
  ctx.setLineDash([]);
}

function photoHint() {
  const n = zones.filter((z) => !z.manual).length;
  const found = n === 0 ? 'Aucun visage détecté.' : n === 1 ? '1 visage détecté.' : `${n} visages détectés.`;
  $('hint').textContent = `${found} Touchez une zone pour la démasquer ou la remasquer ; tracez un rectangle pour en ajouter une à la main.`;
}

async function runPhotoDetection() {
  status('Recherche des visages…');
  const manual = zones.filter((z) => z.manual);
  const boxes = await detectPhoto(photo, settings().minConfidence);
  zones = boxes.map((b) => ({ ...b, on: true, manual: false })).concat(manual);
  renderPhoto();
  photoHint();
  status('Terminé. Vérifiez le résultat puis téléchargez.');
}

async function openPhoto(file) {
  try {
    photo = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    photo = await new Promise((ok, ko) => {
      const img = new Image();
      img.onload = () => ok(img); img.onerror = ko;
      img.src = URL.createObjectURL(file);
    });
  }
  mode = 'photo';
  zones = [];
  canvas.width = photo.width; canvas.height = photo.height;
  $('work').hidden = false;
  $('go').hidden = $('cancel').hidden = $('progress').hidden = $('result').hidden = true;
  $('download').hidden = false;
  $('download').textContent = 'Télécharger la photo';
  $('download').removeAttribute('href');
  renderPhoto();
  await runPhotoDetection();
}

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'photo') return;
  canvas.setPointerCapture(e.pointerId);
  drag = { start: canvasPoint(e), box: null };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = canvasPoint(e), a = drag.start;
  const box = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
  const min = canvas.width / 60;
  drag.box = box.w > min && box.h > min ? box : null;
  renderPhoto(true, drag.box);
});
canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.box) {
    zones.push({ ...drag.box, on: true, manual: true });
  } else {
    const p = drag.start, m = settings().margin;
    const hit = [...zones].reverse().find((z) => {
      const k = z.manual ? 0 : m / 2;
      return p.x >= z.x - z.w * k && p.x <= z.x + z.w * (1 + k) && p.y >= z.y - z.h * k && p.y <= z.y + z.h * (1 + k);
    });
    if (hit && hit.manual) zones.splice(zones.indexOf(hit), 1);
    else if (hit) hit.on = !hit.on;
  }
  drag = null;
  renderPhoto();
});
canvas.addEventListener('pointercancel', () => { drag = null; if (mode === 'photo') renderPhoto(); });

$('download').addEventListener('click', (e) => {
  if (mode !== 'photo') return;
  e.preventDefault();
  renderPhoto(false);
  canvas.toBlob((blob) => {
    renderPhoto();
    save(blob, `${fileName}-floute.jpg`);
  }, 'image/jpeg', 0.92);
});

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- Vidéo ----------

function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

async function openVideo(file) {
  mode = 'video';
  stopJob();
  if (srcVideo.src) URL.revokeObjectURL(srcVideo.src);
  srcVideo.src = URL.createObjectURL(file);
  srcVideo.muted = true;
  await new Promise((ok, ko) => { srcVideo.onloadeddata = ok; srcVideo.onerror = () => ko(new Error('Format vidéo non lisible par ce navigateur.')); });
  canvas.width = srcVideo.videoWidth; canvas.height = srcVideo.videoHeight;
  $('work').hidden = false;
  $('download').hidden = $('cancel').hidden = $('progress').hidden = $('result').hidden = true;
  $('go').hidden = false;
  // Aperçu : première image, floutée.
  ctx.drawImage(srcVideo, 0, 0);
  const s = settings();
  for (const b of await detect(canvas, s.minConfidence)) hide(b, s);
  $('hint').textContent = 'Aperçu de la première image. Le traitement se fait à vitesse réelle : une vidéo de 1 minute prend 1 minute. Gardez cet onglet visible pendant ce temps.';
  status('Vidéo prête.');
}

async function startVideo() {
  if (!window.MediaRecorder || !canvas.captureStream) {
    status("Ce navigateur ne permet pas d'enregistrer la vidéo. Essayez Chrome, Edge ou Firefox récents.", true);
    return;
  }
  $('go').hidden = true; $('cancel').hidden = false; $('download').hidden = true; $('result').hidden = true;
  $('progress').hidden = false; $('progress').value = 0;
  status('Traitement de la vidéo en cours…');

  const stream = canvas.captureStream(30);
  // Le son passe par WebAudio pour être enregistré sans sortir des haut-parleurs.
  let audioCtx = null;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!srcVideo._node) srcVideo._node = { ctx: audioCtx, node: audioCtx.createMediaElementSource(srcVideo) };
    else audioCtx = srcVideo._node.ctx;
    await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();
    srcVideo._node.node.disconnect();
    srcVideo._node.node.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    srcVideo.muted = false;
  } catch (err) {
    console.warn('Son non repris', err);
  }

  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.min(12e6, Math.max(2e6, canvas.width * canvas.height * 4)) });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const me = job = { active: true, tracks: [], recorder, cancelled: false };
  const s0 = settings();

  // Première détection avant de démarrer, pour que la toute première image soit masquée.
  srcVideo.currentTime = 0;
  await new Promise((ok) => { srcVideo.onseeked = ok; if (srcVideo.currentTime === 0 && srcVideo.readyState >= 2) ok(); });
  me.tracks = (await detect(srcVideo, s0.minConfidence)).map((b) => ({ ...b, seen: performance.now() }));

  // Boucle de détection : tourne en continu sur l'image courante.
  (async () => {
    while (me.active) {
      const boxes = await detect(srcVideo, settings().minConfidence).catch(() => []);
      const now = performance.now();
      // On garde chaque zone 0,6 s après sa dernière détection pour couvrir les ratés ponctuels.
      const kept = me.tracks.filter((t) => now - t.seen < 600 && !boxes.some((b) => iou(b, t) > 0.2));
      me.tracks = boxes.map((b) => ({ ...b, seen: now })).concat(kept);
      await new Promise((ok) => setTimeout(ok, 0));
    }
  })();

  const draw = () => {
    if (!me.active) return;
    const s = settings();
    ctx.drawImage(srcVideo, 0, 0, canvas.width, canvas.height);
    // Marge élargie : la détection a toujours un léger retard sur l'image.
    for (const t of me.tracks) hide(t, { ...s, margin: s.margin + 0.35 });
    $('progress').value = srcVideo.currentTime / (srcVideo.duration || 1);
    next();
  };
  const next = () => (srcVideo.requestVideoFrameCallback ? srcVideo.requestVideoFrameCallback(draw) : requestAnimationFrame(draw));

  recorder.onstop = () => {
    me.active = false;
    $('cancel').hidden = true; $('progress').hidden = true; $('go').hidden = false;
    $('go').textContent = 'Recommencer';
    if (me.cancelled) { status('Traitement annulé.'); return; }
    const type = (mimeType || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    $('result').src = resultUrl; $('result').hidden = false;
    const a = $('download');
    a.href = resultUrl; a.download = `${fileName}-floute.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    a.textContent = 'Télécharger la vidéo'; a.hidden = false;
    status('Terminé. Regardez la vidéo en entier avant de la publier.');
  };
  srcVideo.onended = () => recorder.state !== 'inactive' && recorder.stop();

  draw();
  recorder.start(1000);
  await srcVideo.play();
}

function stopJob() {
  if (!job || !job.active) return;
  job.cancelled = true;
  job.active = false;
  srcVideo.pause();
  if (job.recorder.state !== 'inactive') job.recorder.stop();
}

$('go').addEventListener('click', () => startVideo().catch((err) => { console.error(err); status('Erreur : ' + err.message, true); }));
$('cancel').addEventListener('click', stopJob);

// ---------- Fichiers et réglages ----------

async function openFile(file) {
  if (!file) return;
  if (!ready) { status('Le détecteur est encore en cours de chargement, réessayez dans un instant.'); return; }
  fileName = file.name.replace(/\.[^.]+$/, '') || 'fichier';
  stopJob();
  try {
    if (file.type.startsWith('video/')) await openVideo(file);
    else if (file.type.startsWith('image/')) await openPhoto(file);
    else status('Type de fichier non pris en charge : choisissez une photo ou une vidéo.', true);
  } catch (err) {
    console.error(err);
    status('Impossible de lire ce fichier : ' + (err.message || err), true);
  }
}

$('file').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => openFile(e.dataTransfer.files[0]));

for (const id of ['style', 'strength', 'margin']) {
  $(id).addEventListener('input', () => { if (mode === 'photo' && photo) renderPhoto(); });
}
$('sens').addEventListener('change', () => { if (mode === 'photo' && photo) runPhotoDetection(); });

(async () => {
  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri('models');
    ready = true;
    status('Prêt. Choisissez une photo ou une vidéo.');
  } catch (err) {
    console.error(err);
    status('Le détecteur de visages n’a pas pu être chargé. Rechargez la page.', true);
  }
})();
