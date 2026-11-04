# HOW-TO: Menjalankan multidb-mcp dan memakainya di project Anda

Panduan ini menjelaskan cara memasang multidb-mcp untuk dipakai Claude Code di project aplikasi Anda.
Ada dua cara yang didukung: **Docker** (disarankan) dan **Node langsung** di host. Keduanya
**tidak memerlukan server yang dijalankan manual atau pengelola proses seperti pm2**: Claude Code
menjalankan server sendiri.

## Daftar isi

1. [Cara kerja singkat](#1-cara-kerja-singkat)
2. [Pilih cara menjalankan](#2-pilih-cara-menjalankan)
3. [Siapkan file di project Anda](#3-siapkan-file-di-project-anda)
4. [Cara A: Docker](#4-cara-a-docker)
5. [Cara B: Node langsung](#5-cara-b-node-langsung)
6. [Pakai di Claude Code](#6-pakai-di-claude-code)
7. [Verifikasi](#7-verifikasi)
8. [Pembaruan](#8-pembaruan)
9. [Troubleshooting](#9-troubleshooting)

## 1. Cara kerja singkat

multidb-mcp adalah server MCP yang berbicara lewat **stdio** (stdin/stdout). Artinya:

- Claude Code **menjalankan sendiri** server ini sebagai proses anak setiap kali sesi dibuka, dan
  menghentikannya saat sesi ditutup.
- Server tidak membuka port jaringan dan tidak berjalan sebagai layanan di latar belakang.
- **Anda tidak perlu menjalankan server secara manual dan tidak perlu menjalankannya sebagai layanan**:
  tanpa `npm start`, tanpa pm2 atau pengelola proses lain, tanpa `docker run` terpisah. Anda cukup
  mendaftarkan **perintah untuk menjalankannya** di `.mcp.json`.
- Yang Anda lakukan sendiri hanya persiapan sekali di awal: build, membuat `databases.json` dan
  `.env.multidb`, lalu mendaftarkan `.mcp.json`.

```
Claude Code ──(stdio)──> docker run ... multidb-mcp  ──> PostgreSQL / MySQL / Db2 / SQLite / Redis
                         (atau: node dist/index.js)
```

Konsekuensinya: konfigurasi (`databases.json`) dan password (`.env.multidb`) disimpan **di project
aplikasi Anda**, bukan di repo multidb-mcp. Satu image/build bisa dipakai banyak project.

## 2. Pilih cara menjalankan

| Hal                      | A. Docker                                  | B. Node langsung                            |
| ------------------------ | ------------------------------------------ | ------------------------------------------- |
| Db2                      | Berfungsi                                  | **Gagal di Ubuntu 26.04** (butuh libxml2.so.2) |
| PostgreSQL/MySQL/SQLite/Redis | Berfungsi                             | Berfungsi                                   |
| Yang dipasang di host    | Hanya Docker                               | Node.js 24 + `npm install` + `npm run build` |
| Kecepatan start          | Sedikit lebih lambat (start container)     | Cepat                                       |
| Isolasi                  | Hanya melihat file yang di-mount           | Berjalan dengan hak akses user Anda         |
| Konsisten dev ↔ produksi | Ya (image yang sama)                       | Tergantung versi Node di tiap mesin         |

**Rekomendasi:** pakai **Docker** jika Anda butuh Db2 atau ingin hasil yang sama di laptop dan
server Linux produksi. Pakai **Node langsung** jika hanya memakai PostgreSQL/MySQL/SQLite/Redis dan
ingin start paling cepat.

## 3. Siapkan file di project Anda

Langkah ini sama untuk kedua cara. Contoh di bawah memakai `/home/rede/projects/aplikasi`; ganti sesuai
project Anda.

### 3.1 Lindungi file rahasia dulu

Tambahkan ke `.gitignore` project **sebelum** membuat file password:

```bash
cd /home/rede/projects/aplikasi
printf '\n# multidb-mcp\n.env.multidb\n.multidb/\n' >> .gitignore
```

### 3.2 `databases.json`

```bash
cp /home/rede/Apps/TYPESCRIPT/multidb-mcp/templates/databases.example.json databases.json
```

Sunting: hapus koneksi yang tidak Anda perlukan dan sesuaikan `host`, `port`, `database`, `user`.
Aturan penting:

- `access` **wajib** dan harus memuat `read`. Berikan izin sesempit mungkin (mis. production
  `["read"]`).
- Password **hanya** boleh berupa `"${NAMA_VARIABEL}"`. Password asli di file ini membuat server
  menolak start.
- `description` dipakai Claude untuk memilih koneksi, jadi tulis dengan jelas.

`databases.json` aman di-commit jika host internal tidak rahasia. Jika rahasia, tulis
`"host": "${PG_HOST}"` dan taruh nilainya di `.env.multidb`.

### 3.3 `.env.multidb` (hanya password)

```bash
cp /home/rede/Apps/TYPESCRIPT/multidb-mcp/templates/env.multidb.example .env.multidb
chmod 600 .env.multidb
```

Isi nilai asli. Setiap variabel yang dirujuk `databases.json` harus ada dan tidak kosong, jika tidak
server menolak start. Karakter khusus (`@ : / #`) boleh dipakai di password; di-encode otomatis.

> Gunakan **user database khusus** dengan hak minimum (production: hanya `SELECT`). Pembatasan di
> `access` adalah lapisan kedua, bukan pengganti hak akses di database.

### 3.4 Folder audit

```bash
mkdir -p .multidb
```

Server menulis log audit (siapa menjalankan apa, tanpa nilai data) ke sini. Folder ini sudah masuk
`.gitignore` di langkah 3.1.

## 4. Cara A: Docker

### 4.1 Prasyarat

- Docker terpasang dan user Anda boleh menjalankannya (`docker ps` berhasil tanpa `sudo`).

### 4.2 Build image (sekali, dan setiap kali Anda memperbarui multidb-mcp)

```bash
cd /home/rede/Apps/TYPESCRIPT/multidb-mcp
npm run docker:build
docker image ls multidb-mcp     # harus ada tag 0.9.0 dan latest
```

Build pertama agak lama karena mengunduh driver Db2 dan mengompilasi dependensi native. Image akhir
berbasis `node:24-bookworm-slim` dan berjalan sebagai user `node` (bukan root).

### 4.3 Daftarkan di `.mcp.json` project Anda

Buat `/home/rede/projects/aplikasi/.mcp.json`:

```json
{
  "mcpServers": {
    "multidb": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--init", "--pull=never",
        "--network", "host",
        "-e", "TZ=Asia/Jakarta",
        "-v", "/home/rede/projects/aplikasi/databases.json:/work/databases.json:ro",
        "-v", "/home/rede/projects/aplikasi/.env.multidb:/work/.env.multidb:ro",
        "-v", "/home/rede/projects/aplikasi/.multidb:/work/.multidb",
        "multidb-mcp:latest",
        "--config", "/work/databases.json",
        "--dotenv", "/work/.env.multidb"
      ]
    }
  }
}
```

Arti setiap bagian:

| Bagian                        | Fungsi                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `-i`                          | Wajib. Menjaga stdin tetap terbuka untuk protokol MCP.                              |
| `--rm`                        | Container dihapus saat sesi selesai.                                                |
| `--init`                      | Menangani sinyal dengan benar agar container berhenti bersih.                       |
| `--pull=never`                | Tidak pernah mengunduh image; memakai image hasil build lokal.                      |
| `--network host`              | Container melihat jaringan host: `127.0.0.1`, jaringan kantor, dan VPN.             |
| `-e TZ=...`                   | Zona waktu untuk pembagian file audit per tanggal. Container default UTC.           |
| `-v ...:ro`                   | Config dan password di-mount **read-only**.                                         |
| `-v .multidb:/work/.multidb`  | Satu-satunya folder yang bisa ditulis (audit).                                      |
| `--config`, `--dotenv`        | Path **di dalam container** (`/work/...`), bukan path host.                         |

> Path di `-v` harus **absolut**. `~` dan `$HOME` tidak diperluas di `.mcp.json`.

### 4.4 Uji manual sebelum membuka Claude Code

```bash
cd /home/rede/projects/aplikasi
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | docker run -i --rm --init --pull=never --network host \
      -v "$PWD/databases.json:/work/databases.json:ro" \
      -v "$PWD/.env.multidb:/work/.env.multidb:ro" \
      -v "$PWD/.multidb:/work/.multidb" \
      multidb-mcp:latest --config /work/databases.json --dotenv /work/.env.multidb
```

Hasil yang benar: satu baris JSON berisi `"result"` dengan nama server. Jika ada pesan error, server
menyebut field atau variabel yang salah.

## 5. Cara B: Node langsung

### 5.1 Prasyarat

- Node.js 24 (`node -v`).

### 5.2 Build (sekali, dan setiap kali memperbarui)

```bash
cd /home/rede/Apps/TYPESCRIPT/multidb-mcp
npm install
npm run build
```

### 5.3 Daftarkan di `.mcp.json` project Anda

```json
{
  "mcpServers": {
    "multidb": {
      "command": "node",
      "args": [
        "/home/rede/Apps/TYPESCRIPT/multidb-mcp/dist/index.js",
        "--config", "databases.json",
        "--dotenv", ".env.multidb"
      ]
    }
  }
}
```

`databases.json` dan `.env.multidb` di sini relatif terhadap folder kerja. Claude Code menjalankan
server dari root project, jadi cukup letakkan keduanya di root project.

Catatan: jika `databases.json` berisi koneksi Db2, cara ini gagal di Ubuntu 26.04. Pakai Cara A.

## 6. Pakai di Claude Code

1. Buka project aplikasi Anda di Claude Code (dari terminal: `cd` ke project, lalu `claude`).
2. Claude Code meminta persetujuan untuk server `multidb` dari `.mcp.json`. Setujui.
3. Ketik `/mcp`. Status `multidb` harus **connected**.
4. Sebagai langkah opsional yang disarankan:
   - Salin `templates/settings.example.json` ke `.claude/settings.json`. Tool baca berjalan tanpa
     konfirmasi, sedangkan `execute_sql` dan `redis_command` tetap meminta persetujuan.
   - Salin `templates/CLAUDE.md.example` ke `CLAUDE.md` project dan sesuaikan nama koneksi. Isinya
     aturan agar Claude tidak menyentuh production tanpa diminta dan selalu menyebut koneksi yang
     dipakai.

Contoh permintaan:

```
Tampilkan daftar database yang tersedia.
Di local_mysql, tabel apa saja yang ada dan seperti apa struktur tabel orders?
Berapa jumlah baris per status di tabel orders pada staging_pg?
```

## 7. Verifikasi

Daftar periksa setelah pemasangan:

- [ ] `/mcp` menampilkan `multidb` **connected**.
- [ ] "Tampilkan daftar database" memunculkan semua koneksi dengan kolom `access` yang benar.
- [ ] `SELECT 1` pada koneksi yang diizinkan berhasil.
- [ ] `DELETE` pada koneksi `["read"]` **ditolak** sebelum menyentuh database.
- [ ] File audit muncul di `.multidb/`.
- [ ] `git status` project **tidak** menampilkan `.env.multidb` atau `.multidb/`.

## 8. Pembaruan

```bash
cd /home/rede/Apps/TYPESCRIPT/multidb-mcp
git pull
npm run docker:build      # Cara A
# atau
npm install && npm run build   # Cara B
```

Lalu mulai ulang sesi Claude Code (atau `/mcp` → hubungkan ulang) agar memakai build baru.

## 9. Troubleshooting

| Gejala                                                | Penyebab umum                                      | Perbaikan                                                                 |
| ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `/mcp` menampilkan **failed**                         | Config salah atau variabel env kosong              | Jalankan perintah uji (4.4) dan baca pesan error-nya                      |
| `Unable to find image 'multidb-mcp:latest'`           | `--pull=never` dan image belum di-build            | `npm run docker:build`                                                    |
| `permission denied` saat menulis `.multidb`           | UID user host berbeda dari user `node` (1000) di container | `chown -R 1000:1000 .multidb`, atau tambah `"--user", "UID:GID"` di args (cek `id -u`) |
| `libxml2.so.2: cannot open shared object` (Db2)       | Memakai Cara B di Ubuntu 26.04                     | Pakai Cara A (Docker)                                                     |
| Tidak bisa menjangkau database di `127.0.0.1`         | Tidak memakai `--network host`                     | Tambahkan `--network host`                                                |
| Timeout ke database kantor                            | VPN mati atau firewall                             | Cek dari host: `nc -vz host port`                                         |
| Nama file audit memakai tanggal yang salah            | Container berjalan dalam UTC                       | Tambahkan `-e TZ=Asia/Jakarta`                                            |
| Server menolak start: "password" di config            | Password ditulis langsung di `databases.json`      | Ganti dengan `"${NAMA_VAR}"` dan pindahkan nilainya ke `.env.multidb`     |
| Perubahan `databases.json` tidak berlaku              | Server dibaca saat start                           | Mulai ulang sesi Claude Code                                              |
