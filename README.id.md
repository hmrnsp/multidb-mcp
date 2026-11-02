# multidb-mcp

Server [Model Context Protocol](https://modelcontextprotocol.io) yang memberi Claude Code akses
terjaga ke **PostgreSQL, MySQL/MariaDB, IBM Db2 LUW, SQLite, dan Redis** lewat satu set tool kecil.

Setiap koneksi menyatakan izinnya (`read`, `insert`, `update`, `delete`, `ddl`, `call`) di file
konfigurasi. Guard SQL memeriksa setiap permintaan **sebelum** sampai ke database, hasil dipotong dan
disamarkan, dan setiap pemanggilan tool dicatat di audit log.

> [!IMPORTANT]
> Guard adalah lapisan pertama, bukan satu-satunya. Selalu sambungkan dengan user database yang hanya
> punya hak yang dibutuhkan koneksi itu. Lihat [Model keamanan](#model-keamanan).

Dokumen ini ringkasan berbahasa Indonesia. Rincian lengkap (aturan guard, perilaku tiap database, tabel
troubleshooting) ada di [README.md](README.md) dalam bahasa Inggris.

## Tool

Server hanya mendaftarkan tool yang dibutuhkan koneksi di config.

| Tool             | Fungsi                                                                | Didaftarkan bila  |
| ---------------- | --------------------------------------------------------------------- | ----------------- |
| `list_databases` | Daftar koneksi: id, driver, env, izin, batas, status, deskripsi       | selalu            |
| `list_tables`    | Daftar tabel dan view                                                 | ada koneksi SQL   |
| `describe_table` | Kolom, primary key, foreign key, dan index satu tabel                 | ada koneksi SQL   |
| `execute_sql`    | Menjalankan **satu** statement SQL (parameter diikat, bukan digabung) | ada koneksi SQL   |
| `redis_command`  | Menjalankan **satu** perintah Redis, mis. `HGETALL user:42`           | ada koneksi Redis |

## Memulai

Kebutuhan: **Node.js 24 LTS**. Docker dibutuhkan untuk Db2 dan untuk database development.

```bash
git clone https://github.com/hmrnsp/multidb-mcp.git
cd multidb-mcp
npm install
npm run build
```

Buat `databases.json` di project Anda dan file env terpisah untuk kredensial (misalnya
`.env.multidb`, **jangan di-commit**), lalu daftarkan server di `.mcp.json` project:

```json
{
  "mcpServers": {
    "multidb": {
      "command": "node",
      "args": [
        "/path/absolut/ke/multidb-mcp/dist/index.js",
        "--config",
        "databases.json",
        "--dotenv",
        ".env.multidb"
      ]
    }
  }
}
```

Buka project di Claude Code, setujui server `multidb`, lalu ketik `/mcp`: statusnya harus
**connected**. Contoh [`templates/`](templates) berisi `databases.json`, `.mcp.json` (node dan Docker),
`CLAUDE.md`, dan `.claude/settings.json`.

Untuk mencoba tanpa menyiapkan apa pun: `cp .env.example .env`, `npm run db:up`,
`npm run seed:sqlite`, `npm run seed:redis`, `npm run build`. File `.mcp.json` di repo ini sudah
memakai `databases.dev.json`.

## Konfigurasi dan izin

```json
{
  "defaults": { "maxRows": 200, "timeoutSec": 30, "maxChars": 40000 },
  "databases": [
    {
      "id": "prod_pg",
      "driver": "postgres",
      "env": "production",
      "access": ["read", "update"],
      "description": "PostgreSQL production; boleh memperbaiki data (UPDATE), tidak boleh menambah atau menghapus",
      "url": "${PROD_PG_URL}"
    }
  ]
}
```

- Field `access` **wajib** dan berlaku sama untuk semua env, termasuk production. `read` harus ada;
  nilai lain (`insert`, `update`, `delete`, `ddl`, `call`) membuka jenis tulis tertentu.
- Statement yang butuh beberapa izin diperiksa seluruhnya: `INSERT … ON CONFLICT DO UPDATE` butuh
  `insert` + `update`, `MERGE` butuh `insert` + `update` + `delete`, `TRUNCATE` butuh `ddl` + `delete`.
- Koneksi `["read"]` juga memakai transaksi read-only di database.
- Password tidak boleh ditulis langsung di `url` untuk staging dan production; pakai `${VAR}`.
- Config yang salah (field tidak dikenal, variabel kosong, `access` tidak valid) membuat server
  menolak start dengan pesan yang menyebut masalahnya.
- Opsi baris perintah: `--config`, `--dotenv` (bukan `--env-file`, yang dicegat Node.js), `--log-level`,
  `--log-file`, `--audit-dir`, `--audit-keep-days`, `--no-audit`.

## Guard SQL

Hanya satu statement per panggilan. Guard memakai lexer SQL per dialek tanpa dependensi, menolak
perintah dan fungsi berbahaya (`GRANT`, `COPY`, `pg_sleep`, `LOAD_FILE`, `ADMIN_CMD`, …), menegakkan
whitelist `schemas`, dan memetakan setiap statement ke izin yang dibutuhkan. Query yang ditolak tidak
pernah menyentuh database. Nilai kolom bernama sensitif (`password`, `token`, `nik`, … plus
`maskColumns`) diganti `***`.

Redis memakai allowlist perintah: `FLUSHALL`, `KEYS`, `EVAL`, `CONFIG`, dan perintah berbahaya lain
selalu ditolak; perintah yang bisa memacetkan server (`HGETALL` pada key besar, `LRANGE 0 -1`) dibatasi
sebelum dijalankan; nilai key session dan token disamarkan.

## Docker

Driver Db2 dari IBM butuh `libxml2.so.2`, yang tidak lagi disertakan distro baru seperti Ubuntu
26.04. Image Docker berbasis Debian 12 menyelesaikannya tanpa memasang apa pun di host:

```bash
npm run docker:build        # image multidb-mcp:<versi> dan multidb-mcp:latest
npm run db:up:db2           # Db2 lokal (start pertama 5-10 menit, butuh sekitar 4 GB RAM)
npm run docker:dev -- node scripts/seed-db2.mjs
npm run docker:dev -- npm run test:db2
```

Template [`templates/mcp.docker.example.json`](templates/mcp.docker.example.json) menjalankan image
dari Claude Code. Container berjalan dalam UTC; tambahkan `-e TZ=Asia/Jakarta` (atau zona Anda) agar
file audit dibagi menurut tanggal lokal.

## Audit log

Setiap pemanggilan tool ditulis sebagai satu baris JSON di `.multidb/audit-YYYY-MM-DD.jsonl`.
**Tidak pernah** disimpan: nilai `params`, isi baris hasil, nilai Redis, dan password. File lebih dari
90 hari dihapus otomatis (`--audit-keep-days`, atau `--no-audit` untuk mematikannya). Tambahkan
`.multidb/` ke `.gitignore` project Anda.

Bila koneksi yang sudah terbuka putus, operasi **baca** diulang sekali dengan koneksi baru. Operasi
**tulis tidak pernah diulang**: Claude diminta mengecek dulu apakah perubahan sudah tersimpan.

## Model keamanan

- Pakai **user database khusus** per koneksi dengan hak sesuai `access`: hanya `SELECT` untuk
  `["read"]`, dan user ACL untuk Redis. Jangan memakai akun aplikasi atau DBA.
- Apa pun yang bisa dibaca user database bisa masuk ke konteks model. Sediakan VIEW tanpa kolom
  rahasia; masking hanyalah lapisan tambahan.
- Akses production lewat VPN atau SSH tunnel; jangan membuka port database ke publik.
- Isi tabel adalah data, bukan instruksi. Kredensial dan host disamarkan dari error, log, dan hasil
  tool; sebuah uji protokol memastikannya.
- Password di `docker-compose.yml` dan `.env.example` hanya untuk container lokal di `127.0.0.1`.

Melaporkan celah keamanan: lihat [SECURITY.md](SECURITY.md).

## Pengembangan

```bash
npm install
npm run typecheck && npm run lint
npm test                    # unit test, tanpa database
npm run db:up && npm run test:integration && npm run test:protocol
```

Panduan kontribusi ada di [CONTRIBUTING.md](CONTRIBUTING.md). Lisensi: [MIT](LICENSE).
