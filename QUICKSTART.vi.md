# Bắt đầu — từng bước

[English](QUICKSTART.md) · **Tiếng Việt**

Hướng dẫn này đưa bạn từ con số 0 đến một cửa sổ chat có memory. Mỗi bước đều
có **kết quả mong đợi** để bạn biết đã đúng hay chưa trước khi đi tiếp.

Có hai đường. Đọc bảng này rồi chọn một, đừng làm cả hai.

| | Đường A — cá nhân | Đường B — đầy đủ |
|---|---|---|
| Dành cho | một người, một máy | nhiều người, hoặc bạn muốn đủ tính năng |
| Cần cài | Node 22+, Claude CLI | thêm Docker (hoặc Postgres) |
| Memory | từ plugin DAI Memory | Brain Core (hybrid retrieval) |
| Có citation, pre-tìm memory, tự học | không | có |
| Thời gian | ~5 phút | ~15 phút |

> **Nếu terminal là đủ với bạn thì không cần hướng dẫn này.** Chỉ cần cài plugin
> (bước 2 bên dưới) là bạn có memory ngay trong Claude Code, không cần Gateway,
> không cần UI, không cần database. Phần còn lại chỉ đáng làm nếu bạn thật sự
> muốn cái cửa sổ chat.

---

## Đường A — chat cá nhân, không database

### Bước 0. Kiểm tra máy

```bash
node --version      # phải >= v22
claude --version
```

**Mong đợi:** Node `v22.x` trở lên, và Claude CLI in ra một số phiên bản.

<details>
<summary>Nếu Node < 22</summary>

Đường A dùng `node:sqlite`, chỉ có từ Node 22. Nâng cấp Node, hoặc đi Đường B
(Postgres chạy được trên Node 20).
</details>

<details>
<summary>Nếu chưa có <code>claude</code></summary>

```bash
npm install -g @anthropic-ai/claude-code
```
</details>

### Bước 1. Đăng nhập Claude CLI, rồi đặt hai biến

```bash
claude            # đăng nhập một lần nếu chưa, rồi thoát
export CLAUDE_MODEL=claude-sonnet-5      # Windows: set CLAUDE_MODEL=...
```

Nếu bạn có API key riêng thì dùng nó thay cho login:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Tại sao bước này đứng đầu:** mỗi tin nhắn spawn nguyên một phiên Claude CLI.
Không có API key, nó dùng login sẵn có của bạn và tính vào subscription của bạn
— một con bug có thể khoá bạn khỏi chính Claude Code bạn đang dùng để sửa nó.
Không đặt `CLAUDE_MODEL` thì mọi lượt chạy bằng model mặc định, là model đắt
nhất.

Bỏ qua được không? Được, Gateway sẽ chạy và cảnh báo. Nhưng đây là thứ đã đốt
hết quota trong lúc phát triển dự án này.

### Bước 2. Cài plugin memory

Trong Claude Code:

```
/plugin marketplace add Exia-thd/DAI-memory-layer-plugin
/plugin install dai-memory
```

Rồi chạy setup một lần của nó (xem README của plugin — nó cài dependency và tải
model embedding).

**Kiểm tra:**

```bash
dai-memory --help
```

**Mong đợi:** in ra danh sách lệnh. Nếu `command not found`, plugin chưa chạy
setup xong.

### Bước 3. Lấy DAI Brain về và build

```bash
git clone -b main https://github.com/Exia-thd/DAI-Brain
cd DAI-Brain
pnpm install
pnpm build
```

**Mong đợi:** `pnpm build` không in ra lỗi nào. Im lặng là thành công.

<details>
<summary>Nếu chưa có pnpm</summary>

```bash
npm install -g pnpm
```
</details>

### Bước 4. Chạy

```bash
pnpm chat --dir C:\Project\Inventory --project inventory
```

Một lệnh đó làm hết phần còn lại: dò ra plugin, ghi `plugin-mcp.json` trỏ đúng
vào nó, chạy `dai-memory init` nếu project chưa có store, rồi mở cửa sổ chat.

**Chưa cài plugin?** Nó sẽ **hỏi** bạn ngay tại terminal và tự làm nếu bạn
bấm Enter: clone plugin về cạnh repo này, `pnpm install`, `pnpm build`, rồi tải
model embedding. Thêm `--install-plugin` để khỏi hỏi.

```bash
pnpm chat --install-plugin --dir C:\Project\Inventory --project inventory
```

Nó tìm plugin ở: thư mục plugin của Claude Code (cả bốn vị trí theo hệ điều
hành), **thư mục cha của repo này** (nơi checkout thường nằm), `~/Projects`,
`~/source/repos`. Dò không ra thì nó in **đúng những đường đã thử** kèm ba cách
sửa. `--plugin <đường dẫn>` chỉ thẳng chỗ; `--no-init` bỏ bước tạo store.

Thay `inventory` bằng tên project của bạn — nó chỉ là nhãn để tách memory giữa
các project.

**Mong đợi:** một khối như thế này.

```
[chat] wrote /.../plugin-mcp.json — edit it if your memory server differs
[chat] http://localhost:8080

[gateway] dai-brain-gateway 0.1.0 on :8080
[gateway]   store:       sqlite — /home/ban/.dai-brain/conversations.db
[gateway]   core:        none (memory comes from the runner's MCP servers)
[gateway]   mcp:         none
[gateway]   runner:      claude (max 1 concurrent)
[gateway]   write-back:  off
[gateway]   extra tools: mcp__dai-memory__dai_memory_search, ...
[gateway]   model:       claude-sonnet-5
[gateway]   cost ceiling: $5.00 per conversation
[gateway]   AUTH DISABLED — every request runs as me/me/inventory
```

Hai dòng cần đọc kỹ:

- `claude auth:` — ghi `your own claude login` nghĩa là nó dùng login của bạn.
  Nếu bạn chưa từng chạy `claude` để đăng nhập, lượt đầu sẽ báo
  `Invalid API key · Please run /login`.
- `model:` — nếu ghi `(CLI default)` thì bạn quên bước 1, và mỗi lượt đang chạy
  model đắt nhất.
- `AUTH DISABLED` — đúng như vậy. **Đừng mở cổng 8080 ra internet**: ai vào được
  cũng tiêu quota của bạn.

### Bước 5. Mở và hỏi

Mở <http://localhost:8080>.

Thử lần lượt:

1. `Xin chào` → có chữ chảy ra từng đoạn.
2. `Hãy nhớ giúp tôi: dự án này dùng PostgreSQL chứ không dùng MongoDB, vì cần transaction.`
   → thấy chip **saving to memory** hiện lên.
3. Bấm **+ New**, rồi hỏi `Dự án này dùng database gì, và vì sao?`
   → thấy chip **searching memory**, và câu trả lời nhắc đúng lý do.

Bước 3 là phép thử thật: hội thoại mới, không có ngữ cảnh nào, câu trả lời phải
đến từ memory.

**Góc dưới trái** hiện chi phí đang chạy, ví dụ `$0.0431 / $5.00 · 2 turns`. Nó
chuyển màu cam khi vượt 80% trần.

---

## Đường B — bản đầy đủ, có Brain Core

### Bước 0. Kiểm tra máy

```bash
node --version      # >= v20 là đủ cho đường này
docker --version
```

### Bước 1. Khởi động hạ tầng

```bash
cd DAI-Brain/infra
cp .env.example .env
```

Mở `.env` và sửa ít nhất:

```bash
GATEWAY_DEV_SCOPE=me/me/inventory
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-5
```

Rồi:

```bash
docker compose up -d
```

**Kiểm tra:**

```bash
curl http://localhost:8081/health
```

**Mong đợi:** JSON có `"ok":true`, và `vectorIndex` ghi `available`.

<details>
<summary>Nếu <code>vectorIndex</code> ghi <code>degraded</code></summary>

Không sao — không có pgvector thì nó quét chính xác, chậm hơn nhưng **đúng**.
Đo trên bộ eval: recall@10 89.6% so với 90.7%. Bạn cần Postgres, không bắt buộc
pgvector.

Nếu nó ghi **IVFFlat**, hãy chạy `pnpm migrate` — đó là index cũ, nó trả về chỉ
một phần store mà không báo lỗi.
</details>

### Bước 2. Mồi memory từ repo của bạn

```bash
cd ..
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain
pnpm ingest:repo /duong/dan/den/project --scope me/me/inventory --dry-run
```

**Mong đợi:** một danh sách những gì *sẽ* được lưu, kèm dòng tổng kết như
`found 52 candidate memories: preference=6 artifact=17 decision=28 note=1`.

**Nếu nó tìm được rất ít hoặc không có gì:** đó là công cụ làm đúng, không phải
hỏng. Nó đọc *lý luận* — ADR, `CONTRIBUTING`, `CLAUDE.md`, đoạn README giải
thích lựa chọn, commit message có phần thân. Một repo chưa từng viết lý luận ra
thì không có gì để đưa. Nó **không** index code.

Ưng rồi thì bỏ `--dry-run`:

```bash
pnpm ingest:repo /duong/dan/den/project --scope me/me/inventory
```

### Bước 3. Mở UI

<http://localhost:8080> — giống Đường A, nhưng giờ có thêm tab **Memory**.

Trong tab Memory, gõ một câu hỏi rồi bấm Enter. Bạn sẽ thấy **fusion report**:

```
branches: vector=9  fts=1  graph=0  ·  9 matched, 0 omitted  ·  453/4000 tokens  ·  16ms
⚠ graph: no entity in this scope matched the query text
```

Đây là công cụ debug quan trọng nhất. Khi kết quả tìm kiếm tệ, dòng này nói cho
bạn biết nhánh nào không đóng góp và **tại sao**.

---

## Khi hỏng

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| `ERR_PNPM_IGNORED_BUILDS` khi cài plugin | pnpm 10 chặn build script, và plugin khai ngoại lệ ở chỗ pnpm 10 không còn đọc | `pnpm chat --install-plugin` tự xử lý; hoặc thêm `onlyBuiltDependencies` vào `pnpm-workspace.yaml` của plugin |
| `lbugjs.node: cannot open shared object file` | build script bị chặn nên binary native chưa được copy | như trên |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node < 22 | nâng Node, hoặc đặt `DATABASE_URL` để dùng Postgres |
| `could not start claude` / `ENOENT` trên Windows | Node không spawn được `.cmd` | `npm root -g` rồi `set CLAUDE_BIN=%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js` |
| `port 8080 is already in use` | lần chạy trước còn sống | đóng cửa sổ terminal đó, hoặc `pnpm chat --port 8090` |
| Không thấy tool memory nào | plugin chưa cài xong | chạy `dai-memory --help`; lệnh MCP là `serve`, không phải `mcp` |
| `No memory store found at or above ...` | lượt chat chạy ở thư mục không có store | truyền `--dir` trỏ đúng thư mục bạn đã chạy `dai-memory init` |
| `This conversation has spent $5.00...` | chạm trần chi phí | bấm **+ New**, hoặc `pnpm chat --budget 20` |
| `Invalid API key · Please run /login` | CLI chưa đăng nhập, hoặc Gateway đang cách ly config dir | chạy `claude` đăng nhập một lần; nếu có `ANTHROPIC_API_KEY` mà vẫn lỗi, đặt `GATEWAY_ISOLATE_CLAUDE_CONFIG=false` |
| Model nói không tin kết quả memory | có MCP server khai báo mà không chạy | bỏ server đó khỏi config; khai báo server chết còn tệ hơn không khai |
| `vectorIndex: degraded — legacy IVFFlat` | index cũ | `pnpm migrate` |
| UI trắng trơn | chưa `pnpm build` | `pnpm build` rồi khởi động lại |

## Bước tiếp theo

- Thêm Jira hoặc MCP server khác vào UI → mục *Cho UI dùng thêm tool khác* trong [README.vi.md](README.vi.md)
- Dùng memory ngay trong terminal Claude Code → mục *Dùng DAI Brain từ Claude Code của chính bạn*
- Hiểu retrieval hoạt động ra sao → mục *Retrieval*
- Chi phí và cách chặn → mục *Nó tốn bao nhiêu, và cái gì chặn lại*
