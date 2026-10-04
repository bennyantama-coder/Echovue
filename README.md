# EchoVue PWA 0.5 — No-Blob FFmpeg Fix

Perbaikan khusus error Safari/Chrome seperti:
`Cannot find module 'blob:https://.../'`.

## Apa yang berubah
- Root FFmpeg worker sekarang file lokal `ffmpeg-class-worker.js` dari origin GitHub Pages yang sama.
- Tidak lagi membuat `classWorkerURL`, `coreURL`, atau `wasmURL` sebagai Blob URL.
- FFmpeg core memakai build ESM resmi dari CDN.
- Parser MPEGVue dari 0.3/0.4 tetap dipertahankan.
- Service worker cache dinaikkan ke `echovue-shell-v5` dan network-first untuk file app.

## GitHub Pages
Upload SELURUH isi folder ini ke repo Pages, termasuk `ffmpeg-class-worker.js`.
Setelah deploy selesai, lakukan hard refresh atau hapus website data versi lama.

## Privasi
File pasien tetap dibaca dan dikonversi di browser. CDN hanya menyediakan kode FFmpeg/WASM.
