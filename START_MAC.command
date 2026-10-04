#!/bin/zsh
cd "$(dirname "$0")"
PORT=8080
if command -v python3 >/dev/null 2>&1; then
  echo "EchoVue berjalan di http://localhost:$PORT"
  echo "Tutup jendela Terminal ini untuk menghentikan server."
  (sleep 1; open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT") &
  python3 -m http.server $PORT
else
  echo "Python 3 tidak ditemukan."
  echo "Pasang Python 3 atau upload folder EchoVuePWA ke hosting HTTPS seperti GitHub Pages/Cloudflare Pages."
  read "?Tekan Enter untuk menutup..."
fi
