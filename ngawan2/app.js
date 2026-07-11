// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const API_URL      = 'https://lidan-co-id.pages.dev/api/contacts_filter_dinamis6';
const AUTH_KEY     = 'admin';
const T_USERS      = 'users_ngawan';
const T_ABSENSI    = 'absensi_ngawan';
const T_NGAWAN     = 'ngawan';
const SESSION_KEY  = 'ngawan_peserta';
const REMEMBER_KEY = 'ngawan_peserta_remember';
const R2  = 'https://indahabadi.my.id/api/upload_r2_lidan';
const CDN = 'https://assets.indahabadi.my.id/';

// ─────────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────────
function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY)) ||
           JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch { return null; }
}
function setSession(u, remember) {
  if (remember) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(u));
    localStorage.setItem(REMEMBER_KEY, '1');
    sessionStorage.removeItem(SESSION_KEY);
  } else {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(u));
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(REMEMBER_KEY);
  }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(REMEMBER_KEY);
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let currentUser   = null;   // { id_x, nama, sektor }
let allSesi       = [];     // rows from ngawan table
let myAbsensi     = [];     // rows from absensi_ngawan for this user
let selectedSesi  = null;   // currently selected row
let pendingQrSesi = null;   // sesi no from URL ?sesi= param, processed after login
let html5QrCode   = null;   // QR scanner instance
let qrScanning    = false;

// Quiz state
let quizSoal      = [];     // array of 5 questions
let quizAnswers   = [];     // user's selected answers (a-e)
let quizIndex     = 0;      // current question index
let quizType      = null;   // 'pre' | 'post'
let quizAbsenRow  = null;   // absensi_ngawan row being updated
let quizSesiRow   = null;   // ngawan row (sesi) for the quiz
let quizFinished  = false;

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
(function boot() {
  const s = getSession();
  if (s) {
    currentUser = s;
    launchApp();
  }
  // restore remember-me checkbox state
  if (localStorage.getItem(REMEMBER_KEY) === '1') {
    document.getElementById('loginRemember').checked = true;
  }

  // Enter key on login
  ['loginNama','loginPass'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });

  // Cek apakah dibuka dari hasil scan QR (?sesi=XX)
  const params = new URLSearchParams(location.search);
  const sesiParam = params.get('sesi');
  if (sesiParam) {
    pendingQrSesi = sesiParam;
    if (currentUser) {
      // sudah login -> langsung proses
      setTimeout(() => applyPendingQrSesi(), 300);
    } else {
      // belum login -> tampilkan info, akan diproses setelah login
      showAuthMsg('Scan QR terdeteksi (Sesi ' + sesiParam + '). Silakan masuk untuk mencatat kehadiran.', 'ok');
    }
  }
})();

// ─────────────────────────────────────────────
// TAB SWITCH
// ─────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('loginForm').style.display    = tab === 'login' ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'));
  });
  hideAuthMsg();
}

// ─────────────────────────────────────────────
// API HELPER
// ─────────────────────────────────────────────
async function apiGet(table, params = {}) {
  const q = new URLSearchParams({ table, limit: 200, offset: 0, ...params });
  const r = await fetch(`${API_URL}?${q}`, { headers: { 'X-Custom-Auth': AUTH_KEY } });
  return r.json();
}

async function apiPost(table, action, body) {
  let url = `${API_URL}?table=${table}&action=${action}`;
  if (action === 'update' && body && body.id_x) {
    url += `&id_x=${encodeURIComponent(body.id_x)}`;
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Custom-Auth': AUTH_KEY },
    body: JSON.stringify(body)
  });
  return r.json();
}

// PUT langsung ke baris (id_x) — dipakai untuk update agar selalu menimpa
// baris yang sama, bukan membuat baris baru (sama seperti pola di cpmi.html).
async function apiPut(table, id_x, body) {
  const r = await fetch(`${API_URL}?table=${table}&id_x=${encodeURIComponent(id_x)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Custom-Auth': AUTH_KEY },
    body: JSON.stringify(body)
  });
  return r.json();
}

// ─────────────────────────────────────────────
// DATA TAMBAHAN ABSENSI (JSON di kolom x_08)
// Semua data lanjutan (selfie masuk/pulang, waktu pulang,
// pretest, posttest) disimpan dalam SATU kolom JSON supaya
// satu sesi/materi = satu baris saja, walau nanti ada
// absensi masuk & pulang.
// ─────────────────────────────────────────────
function parseAbsenData(row) {
  try { return JSON.parse(row?.x_08 || '{}'); } catch (e) { return {}; }
}

async function updateAbsenData(id_x, patch) {
  const existing = myAbsensi.find(r => r.id_x == id_x) || {};
  const data = parseAbsenData(existing);
  Object.assign(data, patch);
  const res = await apiPut(T_ABSENSI, id_x, { x_08: JSON.stringify(data) });
  if (res.success) {
    existing.x_08 = JSON.stringify(data); // update cache lokal juga
  }
  return res;
}

// ─────────────────────────────────────────────
// REGISTER
// ─────────────────────────────────────────────
async function doRegister() {
  const nama    = document.getElementById('regNama').value.trim();
  const sektor  = document.getElementById('regSektor').value;
  const pass    = document.getElementById('regPass').value;
  const confirm = document.getElementById('regPassConfirm').value;

  if (!nama)   return showAuthMsg('Nama wajib diisi.', 'err');
  if (!sektor) return showAuthMsg('Sektor wajib dipilih.', 'err');
  if (!pass)   return showAuthMsg('Password wajib diisi.', 'err');
  if (pass !== confirm) return showAuthMsg('Password dan konfirmasi tidak cocok.', 'err');
  if (pass.length < 4) return showAuthMsg('Password minimal 4 karakter.', 'err');

  const btn = document.getElementById('btnRegister');
  btn.disabled = true; btn.textContent = 'Mendaftarkan...';

  try {
    // Cek duplikasi nama
    const chk = await apiGet(T_USERS, { search: nama, search_col: 'x_01' });
    if (chk.success && chk.data && chk.data.some(r => (r.x_01||'').toLowerCase() === nama.toLowerCase())) {
      showAuthMsg('Nama ini sudah terdaftar. Gunakan nama lain atau langsung masuk.', 'err');
      return;
    }

    const res = await apiPost(T_USERS, 'insert', {
      x_01: nama,
      x_02: pass,
      x_03: sektor
    });

    if (res.success) {
      showAuthMsg('Pendaftaran berhasil! Silakan masuk.', 'ok');
      document.getElementById('regNama').value = '';
      document.getElementById('regPass').value = '';
      document.getElementById('regPassConfirm').value = '';
      setTimeout(() => switchTab('login'), 1500);
    } else {
      showAuthMsg(res.error || 'Gagal mendaftar. Coba lagi.', 'err');
    }
  } catch (e) {
    showAuthMsg('Gagal terhubung ke server.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Buat Akun';
  }
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────
async function doLogin() {
  const nama = document.getElementById('loginNama').value.trim();
  const pass = document.getElementById('loginPass').value;

  if (!nama || !pass) return showAuthMsg('Nama dan password wajib diisi.', 'err');

  const btn = document.getElementById('btnLogin');
  btn.disabled = true; btn.textContent = 'Memeriksa...';

  try {
    // Fetch user by name
    const res = await apiGet(T_USERS, { search: nama, search_col: 'x_01' });

    if (!res.success || !res.data || res.data.length === 0) {
      showAuthMsg('Nama tidak ditemukan. Cek ejaan atau daftar terlebih dahulu.', 'err');
      return;
    }

    const user = res.data.find(r => (r.x_01||'').toLowerCase() === nama.toLowerCase());
    if (!user) {
      showAuthMsg('Nama tidak ditemukan.', 'err');
      return;
    }

    if (user.x_02 !== pass) {
      showAuthMsg('Password salah.', 'err');
      return;
    }

    currentUser = { id_x: user.id_x, nama: user.x_01, sektor: user.x_03 || '—' };
    const remember = document.getElementById('loginRemember').checked;
    setSession(currentUser, remember);
    launchApp();

  } catch (e) {
    showAuthMsg('Gagal terhubung ke server.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Masuk';
  }
}

function doLogout() {
  clearSession();
  location.reload();
}

// ─────────────────────────────────────────────
// AUTH MSG
// ─────────────────────────────────────────────
function showAuthMsg(msg, type) {
  const el = document.getElementById('authMsg');
  el.textContent = msg;
  el.className = 'auth-msg ' + type;
  el.style.display = 'block';
}
function hideAuthMsg() {
  document.getElementById('authMsg').style.display = 'none';
}

// ─────────────────────────────────────────────
// LAUNCH APP
// ─────────────────────────────────────────────
function launchApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  document.getElementById('userLabel').textContent  = currentUser.nama;
  document.getElementById('userAvatar').textContent = currentUser.nama.charAt(0).toUpperCase();
  document.getElementById('userLabelMobile').textContent  = currentUser.nama;
  document.getElementById('userAvatarMobile').textContent = currentUser.nama.charAt(0).toUpperCase();

  // Info di absensi card
  document.getElementById('infoNama').textContent   = currentUser.nama;
  document.getElementById('infoSektor').textContent = currentUser.sektor;

  // Load data
  loadAllSesi().then(() => {
    if (pendingQrSesi) applyPendingQrSesi();
  });
  loadMyAbsensi();
}

// ─────────────────────────────────────────────
// LOAD SESI (ngawan table)
// ─────────────────────────────────────────────
async function loadAllSesi() {
  try {
    const res = await apiGet(T_NGAWAN);
    if (!res.success) throw new Error(res.error);

    allSesi = (res.data || []).sort((a, b) => parseInt(a.x_01||0) - parseInt(b.x_01||0));

    // Update stat beranda
    document.getElementById('statTotalSesi').textContent = allSesi.filter(r => r.x_03).length;

    // Render jadwal page
    renderJadwal();

  } catch (e) {
    showToast('Gagal memuat jadwal sesi.', true);
  }
}

// ─────────────────────────────────────────────
// LOAD MY ABSENSI
// ─────────────────────────────────────────────
async function loadMyAbsensi() {
  try {
    const res = await apiGet(T_ABSENSI, { search: currentUser.id_x, search_col: 'x_01' });
    if (!res.success) throw new Error(res.error);

    myAbsensi = (res.data || []).filter(r => r.x_01 == currentUser.id_x);

    const count = myAbsensi.length;
    document.getElementById('statHadir').textContent      = count;
    document.getElementById('infoTotalHadir').textContent = count;

    // Hitung sisa (akan diupdate setelah sesi dimuat)
    const totalSesi = allSesi.filter(r => r.x_03).length || '—';
    if (typeof totalSesi === 'number') {
      document.getElementById('statSisa').textContent = Math.max(0, totalSesi - count);
    } else {
      document.getElementById('statSisa').textContent = '—';
    }

    renderRiwayat();
    updateSesiBadge();

  } catch (e) {
    document.getElementById('riwayatBody').innerHTML =
      '<div class="loading-text">Gagal memuat riwayat.</div>';
  }
}

// ─────────────────────────────────────────────
// SELECT SESI (from QR scan)
// ─────────────────────────────────────────────
function selectSesiByRow(row) {
  selectedSesi = row;

  document.getElementById('spMateri').textContent   = selectedSesi.x_03 || '—';
  document.getElementById('spPengajar').textContent = selectedSesi.x_02 || '—';
  document.getElementById('sesiPreview').style.display = 'block';

  // Cek status absen sesi ini (badge tunggal, teks menyesuaikan)
  refreshAlreadyBadge();
}

// Update teks & tampilan badge "alreadyBadge" sesuai status absen masuk/pulang
function refreshAlreadyBadge() {
  if (!selectedSesi) return;
  const badgeWrap = document.getElementById('alreadyBadge');
  const badgeEl   = badgeWrap.querySelector('.already-badge');
  const existing  = myAbsensi.find(r => r.x_03 == selectedSesi.x_01 && r.x_01 == currentUser.id_x);

  if (!existing) {
    badgeWrap.style.display = 'none';
    return;
  }

  const data = parseAbsenData(existing);
  if (data.waktu_pulang) {
    badgeEl.textContent = '✅ Sudah absen masuk & pulang di sesi ini';
  } else {
    badgeEl.textContent = '✅ Sudah absen masuk — scan lagi untuk absen pulang';
  }
  badgeWrap.style.display = 'block';
}

// ─────────────────────────────────────────────
// QR SCANNER
// ─────────────────────────────────────────────
function toggleQrScanner() {
  if (qrScanning) {
    stopQrScanner();
  } else {
    startQrScanner();
  }
}

function startQrScanner() {
  const wrap   = document.getElementById('qrReaderWrap');
  const status = document.getElementById('qrStatus');
  const btn    = document.getElementById('btnScan');

  wrap.style.display = 'block';
  status.textContent = 'Mengaktifkan kamera...';
  btn.textContent = '✖️ Tutup Scanner';
  qrScanning = true;

  html5QrCode = new Html5Qrcode('qrReader');
  html5QrCode.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 220 },
    onQrScanSuccess,
    () => { /* ignore per-frame scan errors */ }
  ).then(() => {
    status.textContent = 'Arahkan kamera ke QR Code pada jadwal.';
  }).catch(err => {
    status.textContent = 'Gagal mengakses kamera: ' + err;
    stopQrScanner();
  });
}

function stopQrScanner() {
  const wrap   = document.getElementById('qrReaderWrap');
  const status = document.getElementById('qrStatus');
  const btn    = document.getElementById('btnScan');

  if (html5QrCode) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
  }
  html5QrCode = null;
  qrScanning = false;
  wrap.style.display = 'none';
  status.textContent = '';
  btn.textContent = '📷 Scan QR Code';
}

function onQrScanSuccess(decodedText) {
  // Ambil parameter "sesi" dari URL hasil scan (atau angka mentah)
  let sesiNo = null;
  try {
    const u = new URL(decodedText);
    sesiNo = u.searchParams.get('sesi');
  } catch (e) {
    sesiNo = decodedText.trim();
  }
  if (!sesiNo) {
    showToast('QR tidak valid / tidak dikenali.', true);
    return;
  }

  stopQrScanner();
  applySesiNo(sesiNo, true);
}

// Terapkan nomor sesi (dari QR atau ?sesi= di URL)
function applySesiNo(sesiNo, fromQr) {
  const row = allSesi.find(r => String(r.x_01) == String(sesiNo));
  if (!row) {
    showToast('Sesi ' + sesiNo + ' tidak ditemukan di jadwal.', true);
    return;
  }

  document.getElementById('qrMateri').textContent   = row.x_03 || '—';
  document.getElementById('qrPengajar').textContent = row.x_02 || '—';
  document.getElementById('qrResultCard').style.display = 'block';

  selectSesiByRow(row);

  if (fromQr) {
    const existing = myAbsensi.find(r => r.x_03 == row.x_01 && r.x_01 == currentUser.id_x);
    if (!existing) {
      // Belum absen sama sekali di sesi ini → proses absen MASUK
      openAbsenConfirm(row, 'masuk');
    } else {
      const data = parseAbsenData(existing);
      if (!data.waktu_pulang) {
        // Sudah absen masuk, belum pulang → proses absen PULANG
        openAbsenConfirm(row, 'pulang', existing);
      } else {
        // Sudah absen masuk & pulang
        showToast('ℹ️ Anda telah absen untuk sesi ' + sesiNo + ' (masuk & pulang).');
      }
    }
  }
}

// ─────────────────────────────────────────────
// KONFIRMASI ABSENSI (mencegah salah scan)
// ─────────────────────────────────────────────
let _absenMode       = 'masuk'; // 'masuk' | 'pulang'
let _absenExistingRow = null;   // row absensi yang sudah ada (untuk mode pulang)

function openAbsenConfirm(row, mode, existingRow) {
  _absenMode        = mode || 'masuk';
  _absenExistingRow = existingRow || null;

  const isPulang = _absenMode === 'pulang';

  document.getElementById('confirmSesi').textContent     = 'SESI ' + (row.x_01 || '—');
  document.getElementById('confirmMateri').textContent   = row.x_03 || '—';
  document.getElementById('confirmPengajar').textContent = row.x_02 || '—';

  const titleEl = document.querySelector('#confirmOverlay .confirm-title');
  const subEl   = document.querySelector('#confirmOverlay .confirm-sub');
  if (titleEl) titleEl.textContent = isPulang ? 'Konfirmasi Absen Pulang' : 'Konfirmasi Absen Masuk';
  if (subEl)   subEl.textContent   = isPulang
    ? 'Kamu sudah tercatat hadir di sesi ini. Lanjutkan untuk mencatat waktu pulang.'
    : 'Pastikan ini adalah sesi yang sedang kamu ikuti sebelum mencatat kehadiran.';

  document.getElementById('confirmOverlay').classList.add('open');
}

function closeAbsenConfirm() {
  document.getElementById('confirmOverlay').classList.remove('open');
}

function confirmAbsen() {
  closeAbsenConfirm();
  if (_absenMode === 'pulang') {
    doAbsenPulang();
  } else {
    doAbsen();
  }
}

function cancelAbsenConfirm() {
  closeAbsenConfirm();
  showToast('Absensi dibatalkan. Silakan scan ulang QR yang benar.', true);
}

// Proses ?sesi= dari URL setelah login & data jadwal siap
function applyPendingQrSesi() {
  if (!pendingQrSesi) return;
  showPage('absensi');
  applySesiNo(pendingQrSesi, true);
  pendingQrSesi = null;
  // Bersihkan parameter URL agar tidak terproses ulang saat reload
  if (history.replaceState) {
    history.replaceState({}, '', location.pathname);
  }
}

// ─────────────────────────────────────────────
// ABSEN
// ─────────────────────────────────────────────
async function doAbsen() {
  if (!selectedSesi) return;

  const btn = document.getElementById('btnScan');
  btn.disabled = true;

  try {
    const now = new Date();
    const tanggal = now.toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const res = await apiPost(T_ABSENSI, 'insert', {
      x_01: currentUser.id_x,
      x_02: currentUser.nama,
      x_03: selectedSesi.x_01,   // no sesi
      x_04: selectedSesi.x_03,   // materi
      x_05: tanggal,
      x_06: currentUser.sektor,  // sektor peserta
      x_07: selectedSesi.x_02    // nama pengajar
    });

    if (res.success) {
      showToast('✅ Kehadiran sesi ' + selectedSesi.x_01 + ' tercatat!');
      await loadMyAbsensi();
      refreshAlreadyBadge();

      // Cari row absensi yang baru dibuat untuk sesi ini
      const newRow = myAbsensi.find(r => r.x_03 == selectedSesi.x_01 && r.x_01 == currentUser.id_x)
                     || { id_x: res.id_x, x_03: selectedSesi.x_01, x_01: currentUser.id_x };

      // Lanjutkan dengan selfie verifikasi kehadiran (masuk)
      bukaKameraSelfieAbsen(newRow, 'masuk');
    } else {
      showToast('Gagal menyimpan: ' + (res.error || 'Error'), true);
    }
  } catch (e) {
    showToast('Gagal terhubung ke server.', true);
  }

  btn.disabled = false;
}

// ─────────────────────────────────────────────
// ABSEN PULANG (absen ke-2 untuk sesi yang sama)
// ─────────────────────────────────────────────
async function doAbsenPulang() {
  if (!selectedSesi || !_absenExistingRow) return;

  const btn = document.getElementById('btnScan');
  btn.disabled = true;

  try {
    // Lanjutkan dengan selfie verifikasi pulang.
    // waktu_pulang akan dicatat saat selfie pulang dikirim (kirimSelfieAbsen),
    // bersamaan dengan URL foto selfie_pulang, dalam satu update.
    bukaKameraSelfieAbsen(_absenExistingRow, 'pulang');
  } catch (e) {
    showToast('Gagal terhubung ke server.', true);
  }

  btn.disabled = false;
}

// ─────────────────────────────────────────────
// SELFIE VERIFIKASI ABSEN
// ─────────────────────────────────────────────
let _selfieStream    = null;
let _selfieBlob      = null;
let _selfieAbsenRow  = null;
let _selfieSesiRow   = null;
let _selfieMode      = 'masuk'; // 'masuk' | 'pulang'

function bukaKameraSelfieAbsen(absenRow, mode) {
  _selfieBlob     = null;
  _selfieAbsenRow = absenRow;
  _selfieSesiRow  = selectedSesi;
  _selfieMode     = mode || 'masuk';

  const isPulang = _selfieMode === 'pulang';
  const titleEl = document.querySelector('#selfieOverlay .selfie-title');
  const subEl   = document.querySelector('#selfieOverlay .selfie-sub');
  if (titleEl) titleEl.textContent = isPulang ? '📸 Selfie Verifikasi Pulang' : '📸 Selfie Verifikasi Hadir';
  if (subEl)   subEl.innerHTML     = isPulang
    ? 'Ambil foto selfie untuk memverifikasi kepulanganmu dari sesi ini.<br>Pastikan wajah terlihat jelas.'
    : 'Ambil foto selfie untuk memverifikasi kehadiranmu di sesi ini.<br>Pastikan wajah terlihat jelas.';

  document.getElementById('selfieVideoWrap').style.display   = 'block';
  document.getElementById('selfiePreviewWrap').style.display = 'none';
  document.getElementById('selfieLoading').style.display     = 'none';
  document.getElementById('selfieActions').style.display     = 'flex';
  document.getElementById('btnAmbilSelfie').style.display    = 'block';
  document.getElementById('btnUlangSelfie').style.display    = 'none';
  document.getElementById('btnKirimSelfie').style.display    = 'none';

  document.getElementById('selfieOverlay').classList.add('open');

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 960 } }
  }).then(stream => {
    _selfieStream = stream;
    document.getElementById('selfieVideo').srcObject = stream;
  }).catch(() => {
    showToast('Gagal mengakses kamera. Pastikan izin kamera diberikan.', true);
    closeSelfieAbsen();
  });
}

function tutupKameraSelfieAbsen() {
  if (_selfieStream) {
    _selfieStream.getTracks().forEach(t => t.stop());
    _selfieStream = null;
  }
}

function closeSelfieAbsen() {
  tutupKameraSelfieAbsen();
  document.getElementById('selfieOverlay').classList.remove('open');
}

function ambilSelfieAbsen() {
  const vid = document.getElementById('selfieVideo');
  const cvs = document.getElementById('selfieCanvas');
  const vw = vid.videoWidth || 640, vh = vid.videoHeight || 480;
  cvs.width = vw; cvs.height = vh;
  const ctx = cvs.getContext('2d');
  ctx.translate(vw, 0); ctx.scale(-1, 1); // mirror, kamera depan
  ctx.drawImage(vid, 0, 0, vw, vh);

  cvs.toBlob(blob => {
    _selfieBlob = blob;
    const url = URL.createObjectURL(blob);
    document.getElementById('selfiePreviewImg').src = url;
    document.getElementById('selfieVideoWrap').style.display   = 'none';
    document.getElementById('selfiePreviewWrap').style.display = 'block';
    document.getElementById('btnAmbilSelfie').style.display = 'none';
    document.getElementById('btnUlangSelfie').style.display = 'block';
    document.getElementById('btnKirimSelfie').style.display = 'block';
  }, 'image/jpeg', 0.88);
}

function ulangSelfieAbsen() {
  _selfieBlob = null;
  document.getElementById('selfiePreviewImg').src = '';
  document.getElementById('selfiePreviewWrap').style.display = 'none';
  document.getElementById('selfieVideoWrap').style.display   = 'block';
  document.getElementById('btnAmbilSelfie').style.display = 'block';
  document.getElementById('btnUlangSelfie').style.display = 'none';
  document.getElementById('btnKirimSelfie').style.display = 'none';
}

async function kirimSelfieAbsen() {
  if (!_selfieBlob) { showToast('Silakan ambil foto terlebih dahulu.', true); return; }

  document.getElementById('selfieActions').style.display = 'none';
  const loadEl = document.getElementById('selfieLoading');
  loadEl.style.display = 'flex';
  const stTxt = document.getElementById('selfieLoadingText');
  const isPulang = _selfieMode === 'pulang';

  try {
    // 1. Upload selfie ke R2 (storage sama persis dengan cpmi.html)
    stTxt.textContent = 'Mengunggah foto selfie...';
    const fn = `ngawan/selfie_${Date.now()}.jpg`;
    const fd = new FormData();
    fd.append('file', _selfieBlob);
    fd.append('customName', fn);

    const r2 = await fetch(R2, { method: 'POST', headers: { 'X-Custom-Auth': AUTH_KEY }, body: fd }).then(r => r.json());
    if (!r2.success) throw new Error('Gagal upload foto: ' + (r2.error || ''));
    const fotoUrl = r2.url || (CDN + fn);

    // 2. Simpan URL foto ke JSON data absensi (selfie_masuk / selfie_pulang)
    stTxt.textContent = 'Menyimpan data...';
    const now = new Date();
    const tanggal = now.toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const patch = isPulang
      ? { selfie_pulang: fotoUrl, waktu_pulang: tanggal }
      : { selfie_masuk: fotoUrl };

    const res = await updateAbsenData(_selfieAbsenRow.id_x, patch);
    if (!res.success) throw new Error(res.error || 'Gagal menyimpan foto.');

    await loadMyAbsensi();
    closeSelfieAbsen();
    showToast(isPulang ? '✅ Absen pulang tercatat!' : '✅ Selfie verifikasi tersimpan!');

    if (isPulang) {
      // Refresh badge "sudah absen masuk & pulang" di halaman absensi
      updateSesiBadge();
    } else {
      // Lanjutkan ke Pre-Test jika sesi punya soal
      openQuiz('pre', _selfieSesiRow, _selfieAbsenRow);
    }
  } catch (e) {
    loadEl.style.display = 'none';
    document.getElementById('selfieActions').style.display = 'flex';
    showToast('⚠ ' + e.message, true);
  }
}

// ─────────────────────────────────────────────
// QUIZ: PRE-TEST / POST-TEST
// ─────────────────────────────────────────────
// Mapping di absensi_ngawan:
//   x_08 = JSON gabungan data lanjutan, contoh:
//   {
//     "selfie_masuk":  "https://assets...jpg",
//     "waktu_pulang":  "20/06/2026, 18.05",
//     "selfie_pulang": "https://assets...jpg",
//     "pretest":  { "jawaban": ["a","c",...], "skor": "3/5" },
//     "posttest": { "jawaban": ["a","c",...], "skor": "4/5" }
//   }

function openQuiz(type, sesiRow, absenRow) {
  let soal = [];
  try { soal = JSON.parse(sesiRow.x_05 || '[]'); } catch (e) { soal = []; }

  // Lewati jika soal belum diisi (masih template kosong)
  const validSoal = soal.filter(q => q && q.soal);
  if (validSoal.length === 0) {
    if (type === 'post') showToast('Soal untuk sesi ini belum tersedia.', true);
    return;
  }

  // Cek apakah sudah pernah mengisi
  const data    = parseAbsenData(absenRow);
  const already = type === 'pre' ? data.pretest : data.posttest;
  if (already) {
    showToast(type === 'pre' ? 'ℹ️ Pre-Test sesi ini sudah pernah diisi.' : 'ℹ️ Post-Test sesi ini sudah pernah diisi.');
    return;
  }

  quizType     = type;
  quizSoal     = validSoal;
  quizAbsenRow = absenRow;
  quizSesiRow  = sesiRow;
  quizAnswers  = new Array(quizSoal.length).fill(null);
  quizIndex    = 0;
  quizFinished = false;

  document.getElementById('quizOverlay').classList.add('open');
  renderQuizModal();
}

function closeQuiz() {
  document.getElementById('quizOverlay').classList.remove('open');
  quizSoal = []; quizAnswers = []; quizIndex = 0; quizType = null;
  quizAbsenRow = null; quizSesiRow = null; quizFinished = false;
}

function renderQuizModal() {
  const modal = document.getElementById('quizModal');
  const isPre = quizType === 'pre';
  const title = isPre ? '📝 Pre-Test' : '📝 Post-Test';

  if (quizFinished) {
    const score = quizAnswers.reduce((acc, ans, i) => acc + (ans === quizSoal[i].jawaban ? 1 : 0), 0);
    modal.innerHTML = `
      <div class="quiz-header">
        <h2>${title} — Selesai</h2>
        <p>Sesi ${quizSesiRow.x_01} · ${quizSesiRow.x_03 || ''}</p>
      </div>
      <div class="quiz-result">
        <div class="qr-score">${score} / ${quizSoal.length}</div>
        <div class="qr-label">Jawaban benar</div>
      </div>
      <div class="quiz-progress" style="margin-top:18px;">Ringkasan Jawaban</div>
      ${quizSoal.map((q, i) => {
        const correct = quizAnswers[i] === q.jawaban;
        return `
          <div class="quiz-question" style="margin-bottom:6px;font-size:13px;">
            ${i+1}. ${escapeHtml(q.soal)}
            <div style="font-size:12px;margin-top:4px;color:${correct ? 'var(--success)' : 'var(--danger)'}">
              Jawabanmu: ${(quizAnswers[i]||'-').toUpperCase()} ${correct ? '✓' : '— Benar: ' + q.jawaban.toUpperCase()}
            </div>
          </div>
        `;
      }).join('')}
      <div class="quiz-nav">
        <button class="quiz-btn quiz-btn-primary" style="flex:1" onclick="closeQuiz()">Tutup</button>
      </div>
    `;
    return;
  }

  const q = quizSoal[quizIndex];
  const letters = ['a','b','c','d','e'];

  modal.innerHTML = `
    <div class="quiz-header">
      <h2>${title}</h2>
      <p>Sesi ${quizSesiRow.x_01} · ${quizSesiRow.x_03 || ''}</p>
    </div>
    <div class="quiz-progress">Soal ${quizIndex+1} dari ${quizSoal.length}</div>
    <div class="quiz-question">${escapeHtml(q.soal)}</div>
    <div class="quiz-options">
      ${letters.filter(l => q[l]).map(l => `
        <div class="quiz-option ${quizAnswers[quizIndex]===l ? 'selected' : ''}" onclick="selectQuizOption('${l}')">
          <span class="qo-letter">${l.toUpperCase()}</span>
          <span>${escapeHtml(q[l])}</span>
        </div>
      `).join('')}
    </div>
    <div class="quiz-dots">
      ${quizSoal.map((_, i) => `<div class="quiz-dot ${quizAnswers[i] ? 'answered' : ''} ${i===quizIndex ? 'active' : ''}"></div>`).join('')}
    </div>
    <div class="quiz-nav">
      <button class="quiz-btn quiz-btn-secondary" onclick="quizPrev()" ${quizIndex===0 ? 'disabled' : ''}>← Sebelumnya</button>
      <button class="quiz-btn quiz-btn-primary" onclick="quizNext()" ${quizAnswers[quizIndex] ? '' : 'disabled'}>
        ${quizIndex === quizSoal.length - 1 ? 'Selesai' : 'Berikutnya →'}
      </button>
    </div>
  `;
}

function selectQuizOption(letter) {
  quizAnswers[quizIndex] = letter;
  renderQuizModal();
}

function quizPrev() {
  if (quizIndex > 0) { quizIndex--; renderQuizModal(); }
}

function quizNext() {
  if (!quizAnswers[quizIndex]) return;
  if (quizIndex < quizSoal.length - 1) {
    quizIndex++;
    renderQuizModal();
  } else {
    submitQuiz();
  }
}

async function submitQuiz() {
  const score = quizAnswers.reduce((acc, ans, i) => acc + (ans === quizSoal[i].jawaban ? 1 : 0), 0);
  const scoreStr = `${score}/${quizSoal.length}`;
  const isPre = quizType === 'pre';

  const patch = isPre
    ? { pretest:  { jawaban: quizAnswers, skor: scoreStr } }
    : { posttest: { jawaban: quizAnswers, skor: scoreStr } };

  try {
    const res = await updateAbsenData(quizAbsenRow.id_x, patch);
    if (!res.success) {
      showToast('Gagal menyimpan hasil ' + (isPre ? 'pre-test' : 'post-test') + ': ' + (res.error || 'Error'), true);
    } else {
      await loadMyAbsensi();
    }
  } catch (e) {
    showToast('Gagal terhubung ke server saat menyimpan hasil tes.', true);
  }

  quizFinished = true;
  renderQuizModal();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}


function renderRiwayat() {
  const el = document.getElementById('riwayatBody');
  document.getElementById('riwayatCount').textContent = myAbsensi.length;

  if (myAbsensi.length === 0) {
    el.innerHTML = '<div class="loading-text">Belum ada kehadiran yang tercatat.</div>';
    return;
  }

  const sorted = [...myAbsensi].sort((a, b) => parseInt(a.x_03||0) - parseInt(b.x_03||0));

  el.innerHTML = `
    <table class="riwayat-table">
      <thead>
        <tr>
          <th>Sesi</th>
          <th>Materi</th>
          <th>Masuk</th>
          <th>Pulang</th>
          <th>Status</th>
          <th>Pre-Test</th>
          <th>Post-Test</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(r => {
          const sesiRow = allSesi.find(s => s.x_01 == r.x_03);
          const hasSoal = (() => {
            try { return JSON.parse(sesiRow?.x_05 || '[]').filter(q => q && q.soal).length > 0; }
            catch { return false; }
          })();

          let preCell = '<span style="color:var(--muted);font-size:11px">—</span>';
          let postCell = '<span style="color:var(--muted);font-size:11px">—</span>';

          const data = parseAbsenData(r);

          if (hasSoal) {
            preCell = data.pretest?.skor
              ? `<span class="quiz-score-chip">${data.pretest.skor}</span>`
              : `<span style="color:var(--muted);font-size:11px">belum diisi</span>`;

            postCell = data.posttest?.skor
              ? `<span class="quiz-score-chip">${data.posttest.skor}</span>`
              : `<button class="quiz-launch-btn" onclick='openQuizFromRiwayat(${r.id_x})'>Mulai Post-Test</button>`;
          }

          const pulangCell = data.waktu_pulang
            ? data.waktu_pulang
            : '<span style="color:var(--muted);font-size:11px">belum pulang</span>';

          return `
          <tr>
            <td style="font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--gold)">
              ${String(r.x_03||'').padStart(2,'0')}
            </td>
            <td>${r.x_04 || '—'}</td>
            <td style="color:var(--muted);font-size:12px">${r.x_05 || '—'}</td>
            <td style="color:var(--muted);font-size:12px">${pulangCell}</td>
            <td><span class="badge-hadir">Hadir</span></td>
            <td>${preCell}</td>
            <td>${postCell}</td>
          </tr>
        `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// Buka Post-Test dari halaman Riwayat berdasarkan id_x baris absensi
function openQuizFromRiwayat(absenIdX) {
  const absenRow = myAbsensi.find(r => r.id_x == absenIdX);
  if (!absenRow) return;
  const sesiRow = allSesi.find(s => s.x_01 == absenRow.x_03);
  if (!sesiRow) { showToast('Data jadwal sesi tidak ditemukan.', true); return; }
  openQuiz('post', sesiRow, absenRow);
}

// ─────────────────────────────────────────────
// RENDER JADWAL
// ─────────────────────────────────────────────
function renderJadwal() {
  const el = document.getElementById('jadwalBody');

  if (allSesi.length === 0) {
    el.innerHTML = '<div class="loading-text">Tidak ada data jadwal.</div>';
    return;
  }

  el.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:var(--surface2)">
            <th style="padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;white-space:nowrap">No</th>
            <th style="padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Pengajar</th>
            <th style="padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Materi</th>
            <th style="padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Hal</th>
          </tr>
        </thead>
        <tbody>
          ${allSesi.map((r, i) => {
            const absen = myAbsensi.some(a => a.x_03 == r.x_01);
            return `
              <tr style="border-top:${i===0?'none':'1px solid rgba(30,48,88,.5)'}; background:${absen?'rgba(16,185,129,.04)':''}">
                <td style="padding:10px 14px;font-family:'JetBrains Mono',monospace;font-weight:700;color:${absen?'var(--success)':'var(--gold)'}">${r.x_01||'—'}</td>
                <td style="padding:10px 14px;color:var(--accent);font-size:12px">${r.x_02||'—'}</td>
                <td style="padding:10px 14px;">
                  ${r.x_03 || '<span style="color:var(--muted)">—</span>'}
                  ${absen ? '<span style="margin-left:6px;font-size:10px;color:var(--success)">✓</span>' : ''}
                </td>
                <td style="padding:10px 14px;color:var(--muted);font-size:12px">${r.x_04 ? 'hlm.'+r.x_04 : '—'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ─────────────────────────────────────────────
// BADGE CHECK (update already badge when sesi changes after absen)
// ─────────────────────────────────────────────
function updateSesiBadge() {
  if (!selectedSesi) return;
  refreshAlreadyBadge();

  // Update sisa
  const totalSesi = allSesi.filter(r => r.x_03).length;
  document.getElementById('statSisa').textContent = Math.max(0, totalSesi - myAbsensi.length);

  // Re-render jadwal (update checkmarks)
  if (allSesi.length > 0) renderJadwal();
}

// ─────────────────────────────────────────────
// PAGE NAVIGATION
// ─────────────────────────────────────────────
function showPage(name) {
  // Hentikan kamera selfie jika berpindah halaman saat overlay masih terbuka
  if (_selfieStream) closeSelfieAbsen();

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(b => {
    if (b.textContent.trim().toLowerCase().includes(name)) b.classList.add('active');
  });

  closeSidebar();
}

// ─────────────────────────────────────────────
// MOBILE SIDEBAR (BURGER MENU)
// ─────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
function showToast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  setTimeout(() => { t.className = ''; }, 3000);
}
