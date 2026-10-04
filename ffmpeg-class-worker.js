/* EchoVue FFmpeg class worker — same-origin, module-safe, no blob imports. */
let ffmpeg;

async function loadCore({ coreURL, wasmURL, workerURL } = {}) {
  const first = !ffmpeg;
  if (!coreURL) throw new Error('coreURL tidak tersedia.');

  // Root worker ini memang module worker. Gunakan ESM core langsung dari URL HTTPS,
  // jangan importScripts() dan jangan dynamic-import blob: URL (Safari bermasalah di sana).
  const mod = await import(coreURL);
  const createFFmpegCore = mod.default;
  if (typeof createFFmpegCore !== 'function') throw new Error('FFmpeg core ESM tidak valid.');

  const resolvedWasm = wasmURL || coreURL.replace(/\.js$/i, '.wasm');
  const payload = { wasmURL: resolvedWasm };
  if (workerURL) payload.workerURL = workerURL;

  ffmpeg = await createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify(payload))}`,
  });

  ffmpeg.setLogger((data) => self.postMessage({ type: 'LOG', data }));
  ffmpeg.setProgress((data) => self.postMessage({ type: 'PROGRESS', data }));
  return first;
}

function exec({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
}

function ffprobe({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
}

function writeFile({ path, data }) { ffmpeg.FS.writeFile(path, data); return true; }
function readFile({ path, encoding }) { return ffmpeg.FS.readFile(path, { encoding }); }
function deleteFile({ path }) { ffmpeg.FS.unlink(path); return true; }
function rename({ oldPath, newPath }) { ffmpeg.FS.rename(oldPath, newPath); return true; }
function createDir({ path }) { ffmpeg.FS.mkdir(path); return true; }
function listDir({ path }) {
  return ffmpeg.FS.readdir(path).map((name) => {
    const stat = ffmpeg.FS.stat(`${path}/${name}`);
    return { name, isDir: ffmpeg.FS.isDir(stat.mode) };
  });
}
function deleteDir({ path }) { ffmpeg.FS.rmdir(path); return true; }
function mount({ fsType, options, mountPoint }) {
  const fs = ffmpeg.FS.filesystems[fsType];
  if (!fs) return false;
  ffmpeg.FS.mount(fs, options, mountPoint);
  return true;
}
function unmount({ mountPoint }) { ffmpeg.FS.unmount(mountPoint); return true; }

self.onmessage = async ({ data: { id, type, data } }) => {
  const transfer = [];
  let result;
  try {
    if (type !== 'LOAD' && !ffmpeg) throw new Error('FFmpeg belum dimuat.');
    switch (type) {
      case 'LOAD': result = await loadCore(data); break;
      case 'EXEC': result = exec(data); break;
      case 'FFPROBE': result = ffprobe(data); break;
      case 'WRITE_FILE': result = writeFile(data); break;
      case 'READ_FILE': result = readFile(data); break;
      case 'DELETE_FILE': result = deleteFile(data); break;
      case 'RENAME': result = rename(data); break;
      case 'CREATE_DIR': result = createDir(data); break;
      case 'LIST_DIR': result = listDir(data); break;
      case 'DELETE_DIR': result = deleteDir(data); break;
      case 'MOUNT': result = mount(data); break;
      case 'UNMOUNT': result = unmount(data); break;
      default: throw new Error(`Pesan worker tidak dikenal: ${type}`);
    }
  } catch (e) {
    self.postMessage({ id, type: 'ERROR', data: e instanceof Error ? e.toString() : String(e) });
    return;
  }
  if (result instanceof Uint8Array) transfer.push(result.buffer);
  self.postMessage({ id, type, data: result }, transfer);
};
