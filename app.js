/* EchoVue PWA prototype 0.4 — Safari/CDN-safe FFmpeg loader + local-only folder reader */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const els = {
    installBtn: $('#installBtn'), openFolderBtn: $('#openFolderBtn'), folderInput: $('#folderInput'),
    searchInput: $('#searchInput'), libraryStatus: $('#libraryStatus'), examTableBody: $('#examTableBody'),
    libraryView: $('#libraryView'), examView: $('#examView'), backBtn: $('#backBtn'), examTitle: $('#examTitle'), examMeta: $('#examMeta'),
    thumbGrid: $('#thumbGrid'), sourceVideo: $('#sourceVideo'), canvas: $('#videoCanvas'), viewerPlaceholder: $('#viewerPlaceholder'),
    transcodeStatus: $('#transcodeStatus'), timeline: $('#timeline'), timeLabel: $('#timeLabel'), speedSelect: $('#speedSelect'),
    prevCineBtn: $('#prevCineBtn'), nextCineBtn: $('#nextCineBtn'), stepBackBtn: $('#stepBackBtn'), stepForwardBtn: $('#stepForwardBtn'),
    playBtn: $('#playBtn'), stopBtn: $('#stopBtn'), screenshotBtn: $('#screenshotBtn'), fullscreenBtn: $('#fullscreenBtn'), viewerStage: $('#viewerStage'),
    brightness: $('#brightness'), contrast: $('#contrast'), gamma: $('#gamma'), sharpness: $('#sharpness'),
    brightnessOut: $('#brightnessOut'), contrastOut: $('#contrastOut'), gammaOut: $('#gammaOut'), sharpnessOut: $('#sharpnessOut'),
    errorDialog: $('#errorDialog'), errorText: $('#errorText')
  };

  const state = {
    exams: [], filtered: [], currentExam: null, currentCineIndex: -1,
    deferredInstall: null, ffmpeg: null, ffmpegLoaded: false, transcoding: false,
    blobUrl: null, gl: null, renderer: null, ffmpegAssetUrls: [],
    settings: {brightness:0, contrast:1, gamma:1, sharpness:0},
    cache: new Map(),
    currentKind: null, stillImage: null,
  };

  function showError(message) {
    console.error(message);
    els.errorText.textContent = String(message || 'Kesalahan tidak diketahui.');
    if (typeof els.errorDialog.showModal === 'function') els.errorDialog.showModal();
    else alert(message);
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function parseIni(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('#') || (line.startsWith('[') && line.endsWith(']'))) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      out[line.slice(0,i).trim()] = line.slice(i+1).trim();
    }
    return out;
  }

  function joinName(meta) {
    const parts = [meta.PatLastName, meta.PatFirstName].filter(Boolean);
    if (parts.length) return parts.join(', ');
    return meta.PatientName || meta.PatName || 'Tanpa nama';
  }

  function pathOf(file) { return file.webkitRelativePath || file._relativePath || file.name; }
  function dirOf(path) { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(0,i) : ''; }
  function baseOf(path) { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(i+1) : path; }

  async function scanFiles(files) {
    const arr = Array.from(files);

    // MPEGVue exports are not always flat. Some archives put WMV/JPEG in
    // subfolders below Exam.ini, and copied files may gain suffixes such as (1).
    const iniCandidates = arr.filter(f => {
      const name = baseOf(pathOf(f));
      return /^Exam(?:\s*\(\d+\))?\.ini$/i.test(name);
    });

    const examDirs = iniCandidates.map(f => dirOf(pathOf(f)));
    const groups = new Map(iniCandidates.map((f,i) => [examDirs[i], {ini:f, files:[]} ]));

    // Attach every file to the nearest ancestor folder containing Exam.ini.
    // This prevents a parent exam from stealing files belonging to a nested exam.
    for (const f of arr) {
      const fp = pathOf(f);
      const fd = dirOf(fp);
      let best = null;
      for (const d of examDirs) {
        if (fd === d || fd.startsWith(d + '/')) {
          if (best === null || d.length > best.length) best = d;
        }
      }
      if (best !== null) groups.get(best).files.push(f);
    }

    const exams = [];
    for (const [dir, group] of groups.entries()) {
      const ini = group.ini;
      const list = group.files;
      let meta = {};
      try { meta = parseIni(await ini.text()); } catch (e) { console.warn('Gagal membaca Exam.ini', dir, e); }

      const cines = [];
      const thumbs = new Map();
      const usedFiles = new Set();
      const fallbackVideos = [];

      function cleanCopySuffix(name) {
        // m0(1).wmv -> m0.wmv, m0_small (2).jpg -> m0_small.jpg
        return name.replace(/\s*\(\d+\)(?=\.[^.]+$)/, '');
      }

      for (const f of list) {
        const originalName = baseOf(pathOf(f));
        const name = cleanCopySuffix(originalName);

        // Thumbnails first so they are never counted as still-image cine.
        let m = name.match(/^(?:m|cine|image)?[_ -]?(\d+)[_ -]?small\.(jpg|jpeg|png|webp)$/i);
        if (m) {
          const idx = Number(m[1]);
          thumbs.set(idx, f);
          usedFiles.add(f);
          continue;
        }

        // Normal MPEGVue video naming plus common variations.
        m = name.match(/^(?:m|cine|video|image)?[_ -]?(\d+)\.(wmv|mp4|m4v|mov|avi)$/i);
        if (m) {
          cines.push({index:Number(m[1]), file:f, name:originalName, format:m[2].toLowerCase(), kind:'video'});
          usedFiles.add(f);
          continue;
        }

        // Full-size still image such as m0.jpg / image_3.png.
        m = name.match(/^(?:m|cine|image)?[_ -]?(\d+)\.(jpg|jpeg|png|webp)$/i);
        if (m) {
          const idx = Number(m[1]);
          cines.push({index:idx, file:f, name:originalName, format:m[2].toLowerCase(), kind:'image'});
          usedFiles.add(f);
          continue;
        }

        // Last-resort: keep otherwise unrecognised video files in the exam folder.
        if (/\.(wmv|mp4|m4v|mov|avi)$/i.test(name)) fallbackVideos.push(f);
      }

      const occupied = new Set(cines.map(c => c.index));
      let nextIndex = 0;
      for (const f of fallbackVideos) {
        if (usedFiles.has(f)) continue;
        while (occupied.has(nextIndex)) nextIndex++;
        const ext = (baseOf(pathOf(f)).split('.').pop() || '').toLowerCase();
        cines.push({index:nextIndex, file:f, name:baseOf(pathOf(f)), format:ext, kind:'video'});
        occupied.add(nextIndex++);
      }

      cines.sort((a,b) => a.index - b.index || a.name.localeCompare(b.name));
      cines.forEach(c => { c.thumb = thumbs.get(c.index) || (c.kind === 'image' ? c.file : null); });

      exams.push({
        dir, meta, ini,
        id: meta.PatID || meta.PatientID || '', otherId: meta.OtherID || meta.OtherId || '',
        name: joinName(meta), examDate: meta.ExamDate || '', birthDate: meta.BirthDate || '', sex: meta.Sex || '',
        numImages: Number(meta.NumImages || cines.length) || cines.length,
        cines,
        detectedFiles: list.length
      });
    }
    exams.sort((a,b) => `${b.examDate}`.localeCompare(`${a.examDate}`));
    return exams;
  }

  async function scanDirectoryHandle(dirHandle, prefix='') {
    const files = [];
    async function walk(handle, path) {
      for await (const [name, child] of handle.entries()) {
        const rel = path ? `${path}/${name}` : name;
        if (child.kind === 'file') {
          const f = await child.getFile();
          Object.defineProperty(f, '_relativePath', {value: rel, enumerable:false});
          files.push(f);
        } else if (child.kind === 'directory') {
          await walk(child, rel);
        }
      }
    }
    await walk(dirHandle, prefix);
    return files;
  }

  function renderLibrary() {
    const q = els.searchInput.value.trim().toLowerCase();
    state.filtered = !q ? state.exams : state.exams.filter(e => [e.id,e.otherId,e.name,e.examDate,e.birthDate].join(' ').toLowerCase().includes(q));
    els.examTableBody.innerHTML = '';
    if (!state.filtered.length) {
      els.examTableBody.innerHTML = '<tr class="empty-row"><td colspan="6">Tidak ada pemeriksaan yang cocok.</td></tr>';
      return;
    }
    for (const e of state.filtered) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(e.id)}</td><td>${esc(e.otherId)}</td><td>${esc(e.name)}</td><td>${esc(e.examDate)}</td><td>${esc(e.birthDate)}</td><td class="num">${e.numImages || e.cines.length}</td>`;
      tr.addEventListener('click', () => openExam(e));
      els.examTableBody.appendChild(tr);
    }
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function chooseFolder() {
    try {
      if ('showDirectoryPicker' in window) {
        const h = await window.showDirectoryPicker({mode:'read'});
        els.libraryStatus.textContent = 'Membaca folder…';
        const files = await scanDirectoryHandle(h);
        await loadFiles(files);
      } else {
        els.folderInput.click();
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      showError(`Gagal membuka folder: ${e.message || e}`);
    }
  }

  async function loadFiles(files) {
    els.libraryStatus.textContent = `Memindai ${files.length} file…`;
    const exams = await scanFiles(files);
    state.exams = exams;
    els.searchInput.disabled = exams.length === 0;
    els.libraryStatus.textContent = exams.length ? `${exams.length} pemeriksaan ditemukan. Klik baris untuk membuka.` : 'Tidak ditemukan Exam.ini pada folder yang dipilih.';
    renderLibrary();
  }

  async function openExam(exam) {
    state.currentExam = exam;
    state.currentCineIndex = -1;
    stopVideo();
    els.libraryView.hidden = true;
    els.examView.hidden = false;
    els.examTitle.textContent = exam.name || 'Exam View';
    const bits = [exam.id && `ID ${exam.id}`, exam.examDate && `Exam ${exam.examDate}`, exam.birthDate && `DOB ${exam.birthDate}`, `${exam.cines.length} media terdeteksi`, exam.numImages && exam.numImages !== exam.cines.length ? `metadata: ${exam.numImages} image` : ''].filter(Boolean);
    els.examMeta.textContent = bits.join(' • ');
    renderThumbs(exam);
    if (exam.cines.length) await selectCine(0);
    else {
      els.viewerPlaceholder.hidden = false;
      const spin = els.viewerPlaceholder.querySelector('.spinner'); if (spin) spin.hidden = true;
      els.viewerPlaceholder.querySelector('p').textContent = `Metadata terbaca, tetapi file cine/gambar belum dikenali. NumImages=${exam.numImages || 0}. Versi 0.3 menerima media di subfolder serta nama seperti m0.wmv, m0(1).wmv, m_0.wmv, cine1.wmv, dan m0.jpg.`;
    }
  }

  function renderThumbs(exam) {
    els.thumbGrid.innerHTML = '';
    exam.cines.forEach((c, pos) => {
      const card = document.createElement('div');
      card.className = 'thumb';
      card.dataset.pos = pos;
      const tag = document.createElement('span'); tag.className = 'numtag'; tag.textContent = String(pos+1); card.appendChild(tag);
      if (c.thumb) {
        const img = document.createElement('img'); img.alt = `Cine ${pos+1}`; img.src = URL.createObjectURL(c.thumb); card.appendChild(img);
      } else {
        const fb = document.createElement('div'); fb.className = 'fallback'; fb.textContent = `Cine ${pos+1}\n${c.name}`; card.appendChild(fb);
      }
      card.addEventListener('click', () => selectCine(pos));
      els.thumbGrid.appendChild(card);
    });
  }

  function markActiveThumb() {
    [...els.thumbGrid.children].forEach((n,i) => n.classList.toggle('active', i === state.currentCineIndex));
  }

  async function selectCine(pos) {
    const exam = state.currentExam;
    if (!exam || pos < 0 || pos >= exam.cines.length || state.transcoding) return;
    state.currentCineIndex = pos;
    markActiveThumb();
    const cine = exam.cines[pos];
    await loadCine(cine);
  }

  function cleanupBlob() {
    if (state.blobUrl) { URL.revokeObjectURL(state.blobUrl); state.blobUrl = null; }
  }

  const CDN = {
    ffmpeg: [
      'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js',
      'https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/umd/ffmpeg.js'
    ],
    coreBases: [
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
      'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'
    ]
  };

  function loadExternalScript(url) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = url;
      tag.async = true;
      tag.crossOrigin = 'anonymous';
      tag.onload = () => resolve(url);
      tag.onerror = () => { tag.remove(); reject(new Error(`Gagal memuat ${url}`)); };
      document.head.appendChild(tag);
    });
  }

  async function ensureFFmpegLibrary() {
    if (window.FFmpegWASM?.FFmpeg) return;
    let lastErr;
    for (const url of CDN.ffmpeg) {
      try {
        els.transcodeStatus.textContent = 'Memuat library FFmpeg…';
        await loadExternalScript(url);
        if (window.FFmpegWASM?.FFmpeg) return;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`Library FFmpeg tidak dapat dimuat dari CDN. ${lastErr?.message || ''}`.trim());
  }

  async function localFetchFile(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof File || input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
    if (input instanceof URL || typeof input === 'string') {
      const response = await fetch(input);
      if (!response.ok) throw new Error(`Gagal membaca file: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    return new Uint8Array();
  }

  function attachFFmpegEvents(ff) {
    ff.on('log', ({message}) => { if (message) console.debug('[ffmpeg]', message); });
    ff.on('progress', ({progress}) => {
      if (state.transcoding) els.transcodeStatus.textContent = `Mengonversi WMV lokal… ${Math.round((progress || 0)*100)}%`;
    });
  }

  async function ensureFFmpeg() {
    if (state.ffmpegLoaded) return state.ffmpeg;
    await ensureFFmpegLibrary();
    const { FFmpeg } = window.FFmpegWASM;
    const classWorkerURL = new URL('./ffmpeg-class-worker.js', window.location.href).href;
    let lastErr;

    // Safari bermasalah bila root worker atau ffmpeg-core dibuat sebagai blob: URL.
    // Karena itu root worker disajikan dari origin GitHub Pages yang sama dan
    // ffmpeg-core ESM dimuat langsung dari CDN dengan CORS, tanpa blob/module indirection.
    for (const base of CDN.coreBases) {
      const ff = new FFmpeg();
      attachFFmpegEvents(ff);
      try {
        els.transcodeStatus.textContent = 'Memuat mesin FFmpeg (±32 MB, pertama kali saja)…';
        await ff.load({
          classWorkerURL,
          coreURL: `${base}/ffmpeg-core.js`,
          wasmURL: `${base}/ffmpeg-core.wasm`
        });
        state.ffmpeg = ff;
        state.ffmpegLoaded = true;
        return ff;
      } catch (e) {
        console.warn('FFmpeg core gagal dari', base, e);
        lastErr = e;
        try { ff.terminate(); } catch {}
      }
    }
    throw new Error(`Mesin FFmpeg gagal dimuat tanpa Blob URL. ${lastErr?.message || lastErr || ''}`.trim());
  }

  async function transcodeWMV(file) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (state.cache.has(key)) return state.cache.get(key);
    const ff = await ensureFFmpeg();
    const id = Math.random().toString(36).slice(2);
    const input = `in-${id}.wmv`, output = `out-${id}.mp4`;
    await ff.writeFile(input, await localFetchFile(file));
    let ok = false;
    try {
      await ff.exec(['-i', input, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
      ok = true;
    } catch (e) {
      console.warn('libx264 gagal, mencoba MPEG-4', e);
      await ff.exec(['-i', input, '-an', '-c:v', 'mpeg4', '-q:v', '2', output]);
      ok = true;
    }
    if (!ok) throw new Error('Konversi WMV gagal.');
    const data = await ff.readFile(output);
    try { await ff.deleteFile(input); await ff.deleteFile(output); } catch {}
    const blob = new Blob([data.buffer], {type:'video/mp4'});
    state.cache.set(key, blob);
    return blob;
  }

  async function loadCine(cine) {
    stopVideo(); cleanupBlob();
    els.viewerPlaceholder.hidden = false;
    const spin = els.viewerPlaceholder.querySelector('.spinner'); spin.hidden = false;
    els.viewerPlaceholder.querySelector('p').textContent = 'Menyiapkan cine…';
    els.transcodeStatus.hidden = false;
    state.transcoding = true;
    try {
      if (cine.kind === 'image') {
        state.currentKind = 'image';
        const url = URL.createObjectURL(cine.file);
        state.blobUrl = url;
        const img = new Image();
        state.stillImage = img;
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Gambar tidak dapat dibaca.')); img.src = url; });
        els.canvas.width = img.naturalWidth || 800; els.canvas.height = img.naturalHeight || 600;
        const ctx = els.canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D tidak tersedia.');
        ctx.clearRect(0,0,els.canvas.width,els.canvas.height);
        ctx.drawImage(img,0,0,els.canvas.width,els.canvas.height);
        els.timeline.disabled = true; els.speedSelect.disabled = true;
        els.viewerPlaceholder.hidden = true;
        els.timeLabel.textContent = 'Still image';
        els.playBtn.textContent = '▶';
        return;
      }
      state.currentKind = 'video';
      let blob;
      if (cine.format === 'wmv') {
        els.transcodeStatus.textContent = 'Menyiapkan WMV lokal…';
        blob = await transcodeWMV(cine.file);
      } else {
        blob = cine.file;
      }
      state.blobUrl = URL.createObjectURL(blob);
      els.sourceVideo.src = state.blobUrl;
      await new Promise((resolve,reject) => {
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('Video tidak dapat dibaca setelah konversi.')); };
        const cleanup = () => { els.sourceVideo.removeEventListener('loadedmetadata',ok); els.sourceVideo.removeEventListener('error',bad); };
        els.sourceVideo.addEventListener('loadedmetadata',ok,{once:true}); els.sourceVideo.addEventListener('error',bad,{once:true});
        els.sourceVideo.load();
      });
      els.timeline.disabled = false; els.speedSelect.disabled = false;
      els.sourceVideo.loop = true; els.sourceVideo.playbackRate = Number(els.speedSelect.value);
      initRenderer(); resizeCanvas(); renderFrame();
      els.viewerPlaceholder.hidden = true;
      await els.sourceVideo.play().catch(() => {});
      updatePlayButton();
    } catch (e) {
      const detail = e?.message || String(e);
      showError(`${detail}\n\nJika memakai Safari dan ini tetap gagal, coba Chrome terbaru. Data pasien tetap diproses lokal; internet hanya dipakai untuk memuat mesin FFmpeg.`);
      els.viewerPlaceholder.querySelector('p').textContent = 'Gagal membuka cine.';
      spin.hidden = true;
    } finally {
      state.transcoding = false; els.transcodeStatus.hidden = true;
    }
  }

  function initRenderer() {
    if (state.renderer) return;
    const gl = els.canvas.getContext('webgl', {preserveDrawingBuffer:true, premultipliedAlpha:false});
    if (!gl) throw new Error('WebGL tidak tersedia pada browser ini. Gunakan Chrome terbaru di MacBook.');
    const vs = `attribute vec2 aPos; attribute vec2 aTex; varying vec2 vTex; void main(){ gl_Position=vec4(aPos,0.,1.); vTex=aTex; }`;
    const fs = `precision mediump float; varying vec2 vTex; uniform sampler2D uTex; uniform vec2 uPx; uniform float uBrightness; uniform float uContrast; uniform float uGamma; uniform float uSharp;
      void main(){
        vec3 c=texture2D(uTex,vTex).rgb;
        if(uSharp>0.001){
          vec3 n=texture2D(uTex,vTex+vec2(0.,-uPx.y)).rgb;
          vec3 s=texture2D(uTex,vTex+vec2(0., uPx.y)).rgb;
          vec3 e=texture2D(uTex,vTex+vec2( uPx.x,0.)).rgb;
          vec3 w=texture2D(uTex,vTex+vec2(-uPx.x,0.)).rgb;
          c = c*(1.0+4.0*uSharp) - (n+s+e+w)*uSharp;
        }
        c=(c-0.5)*uContrast+0.5;
        c=c+uBrightness;
        c=pow(max(c,vec3(0.0)), vec3(1.0/max(uGamma,0.01)));
        gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);
      }`;
    function shader(type, src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    const p=gl.createProgram(); gl.attachShader(p,shader(gl.VERTEX_SHADER,vs)); gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(p); if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); gl.useProgram(p);
    const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,1, 1,-1,1,1, -1,1,0,0, -1,1,0,0, 1,-1,1,1, 1,1,1,0]),gl.STATIC_DRAW);
    const aPos=gl.getAttribLocation(p,'aPos'), aTex=gl.getAttribLocation(p,'aTex');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(aTex); gl.vertexAttribPointer(aTex,2,gl.FLOAT,false,16,8);
    const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,tex); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    state.gl=gl; state.renderer={p,tex,uPx:gl.getUniformLocation(p,'uPx'),uBrightness:gl.getUniformLocation(p,'uBrightness'),uContrast:gl.getUniformLocation(p,'uContrast'),uGamma:gl.getUniformLocation(p,'uGamma'),uSharp:gl.getUniformLocation(p,'uSharp')};
  }

  function resizeCanvas() {
    const v=els.sourceVideo; if(!v.videoWidth || !v.videoHeight) return;
    if (els.canvas.width !== v.videoWidth || els.canvas.height !== v.videoHeight) { els.canvas.width=v.videoWidth; els.canvas.height=v.videoHeight; }
    if(state.gl) state.gl.viewport(0,0,els.canvas.width,els.canvas.height);
  }

  function renderFrame() {
    if (state.currentKind === 'image') return;
    const v=els.sourceVideo, gl=state.gl, r=state.renderer;
    if(!gl || !r || v.readyState < 2) return;
    resizeCanvas(); gl.bindTexture(gl.TEXTURE_2D,r.tex);
    try { gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,v); } catch { return; }
    gl.uniform2f(r.uPx,1/els.canvas.width,1/els.canvas.height);
    gl.uniform1f(r.uBrightness,state.settings.brightness); gl.uniform1f(r.uContrast,state.settings.contrast); gl.uniform1f(r.uGamma,state.settings.gamma); gl.uniform1f(r.uSharp,state.settings.sharpness);
    gl.drawArrays(gl.TRIANGLES,0,6);
  }

  function renderLoop() {
    renderFrame();
    updateTimeline();
    requestAnimationFrame(renderLoop);
  }

  function updateTimeline() {
    if (state.currentKind === 'image') return;
    const v=els.sourceVideo; if(!Number.isFinite(v.duration) || !v.duration) return;
    if(!els.timeline.matches(':active')) els.timeline.value = Math.round((v.currentTime / v.duration)*1000);
    els.timeLabel.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
  }

  function updatePlayButton(){ els.playBtn.textContent = els.sourceVideo.paused ? '▶' : '❚❚'; }
  function stopVideo(){ const v=els.sourceVideo; try{v.pause(); v.currentTime=0;}catch{} if(state.currentKind !== 'image') updatePlayButton(); }
  function step(sec){ const v=els.sourceVideo; if(!Number.isFinite(v.duration)) return; v.pause(); v.currentTime=Math.min(v.duration,Math.max(0,v.currentTime+sec)); renderFrame(); updatePlayButton(); }

  function applyPreset(name) {
    const presets = {
      original:{brightness:0,contrast:1,gamma:1,sharpness:0},
      gelike:{brightness:0.01,contrast:1.13,gamma:0.92,sharpness:0.12}
    };
    if (presets[name]) Object.assign(state.settings,presets[name]);
    document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', b.dataset.preset===name));
    syncSliders(); renderFrame();
  }
  function syncSliders(){
    for (const k of ['brightness','contrast','gamma','sharpness']) { els[k].value=state.settings[k]; els[`${k}Out`].textContent=Number(state.settings[k]).toFixed(2); }
  }
  function onSlider(k){ state.settings[k]=Number(els[k].value); els[`${k}Out`].textContent=state.settings[k].toFixed(2); document.querySelectorAll('.preset').forEach(b=>b.classList.toggle('active',b.dataset.preset==='custom')); renderFrame(); }

  function screenshot() {
    if(!els.canvas.width) return;
    els.canvas.toBlob(blob => {
      if(!blob) return;
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); const e=state.currentExam; a.download=`EchoVue_${(e?.id||'exam')}_cine${state.currentCineIndex+1}_${Math.round(els.sourceVideo.currentTime*1000)}ms.png`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    },'image/png');
  }

  function bindEvents() {
    els.openFolderBtn.addEventListener('click', chooseFolder);
    els.folderInput.addEventListener('change', e => loadFiles(e.target.files));
    els.searchInput.addEventListener('input', renderLibrary);
    els.backBtn.addEventListener('click', () => { stopVideo(); els.examView.hidden=true; els.libraryView.hidden=false; });
    els.prevCineBtn.addEventListener('click', () => selectCine(Math.max(0,state.currentCineIndex-1)));
    els.nextCineBtn.addEventListener('click', () => selectCine(Math.min((state.currentExam?.cines.length||1)-1,state.currentCineIndex+1)));
    els.playBtn.addEventListener('click', async () => { const v=els.sourceVideo; if(!v.src) return; if(v.paused) await v.play().catch(()=>{}); else v.pause(); updatePlayButton(); });
    els.stopBtn.addEventListener('click', stopVideo);
    els.stepBackBtn.addEventListener('click', () => step(-1/30));
    els.stepForwardBtn.addEventListener('click', () => step(1/30));
    els.timeline.addEventListener('input', () => { const v=els.sourceVideo; if(Number.isFinite(v.duration)) v.currentTime=(Number(els.timeline.value)/1000)*v.duration; });
    els.speedSelect.addEventListener('change', () => { els.sourceVideo.playbackRate=Number(els.speedSelect.value); });
    els.sourceVideo.addEventListener('play',updatePlayButton); els.sourceVideo.addEventListener('pause',updatePlayButton); els.sourceVideo.addEventListener('seeked',renderFrame);
    els.screenshotBtn.addEventListener('click', screenshot);
    els.fullscreenBtn.addEventListener('click', () => els.viewerStage.requestFullscreen?.());
    document.querySelectorAll('.preset').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
    for (const k of ['brightness','contrast','gamma','sharpness']) els[k].addEventListener('input',() => onSlider(k));
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.deferredInstall=e; els.installBtn.hidden=false; });
    els.installBtn.addEventListener('click', async () => { if(!state.deferredInstall) return; state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall=null; els.installBtn.hidden=true; });
  }

  bindEvents(); applyPreset('original'); renderLoop();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
})();
