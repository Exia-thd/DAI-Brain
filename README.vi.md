# DAI Brain

[English](README.md) · **Tiếng Việt**

**Mới bắt đầu? Đọc [hướng dẫn từng bước](QUICKSTART.vi.md).** File này là tài
liệu tra cứu, file kia mới là hướng dẫn làm theo.

Một hệ thống memory gồm bốn thành phần. **Core** là memory service — retrieval,
ingestion, storage. **MCP** expose Core cho Claude dưới dạng bốn tool.
**Gateway** điều phối UI, Claude CLI và Core. **UI** là giao diện chat.

Toàn bộ logic retrieval nằm trong Core. MCP và Gateway chỉ là adapter mỏng —
đó chính là lý do sau này bạn thay Claude CLI bằng Agent SDK, hoặc thay UI này
bằng cái khác, mà không phải đụng vào phần quyết định memory trả về cái gì.

```
dai-brain/
├── core/      memory service: retrieval, ingestion, storage (Postgres + pgvector)
├── mcp/       MCP server adapter — bốn tool qua streamable HTTP
├── gateway/   orchestrator: spawn claude -p, SSE, session, write-back
├── ui/        web UI — chat và memory explorer, không cần build
├── shared/    contract: DTO, event schema, scope model
├── eval/      bộ câu hỏi chuẩn + metric retrieval
└── infra/     docker-compose, Dockerfile, file env mẫu
```

## Chạy nhanh

```bash
cp infra/.env.example infra/.env     # sửa lại cho đúng
cd infra && docker compose up
```

Rồi mở <http://localhost:8080>.

Nếu muốn chạy trực tiếp thay vì Docker:

```bash
pnpm install
pnpm build

export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain
pnpm migrate

pnpm core                                              # :8081
CORE_URL=http://localhost:8081 pnpm mcp                # :8082
GATEWAY_DEV_SCOPE=acme/me/daibrain pnpm gateway        # :8080
```

`GATEWAY_DEV_SCOPE` tắt hoàn toàn xác thực và chạy mọi request dưới một user.
Nó bị từ chối khi `NODE_ENV=production`.

## Chế độ cá nhân: cửa sổ chat, không server nào

Một người, một máy, memory lấy từ plugin. Không Postgres, không Brain Core,
không Brain MCP — chỉ Gateway và giao diện chat.

### Cài đặt

Phải có Claude CLI và đã đăng nhập trước đã: Gateway không phải LLM client, mỗi
tin nhắn nó spawn một tiến trình `claude -p`. Cứ chạy `claude -p "ping"`, trả
lời được là xong phần đó.

**1. Lấy plugin, và chạy nốt setup của nó.** Cài plugin chỉ *copy* repo về. Nó
không cài dependency, không compile, không tải embedding model — mà thiếu một
trong ba thì server không chạy. Lấy kiểu nào cũng được, nhưng `bin/setup.mjs` là
bước hay bị bỏ quên:

```bash
# Cách 1: để launcher tự tải và build (chạy luôn setup.mjs)
pnpm chat --install-plugin --dir /path/to/your/project

# Cách 2: cài trong Claude Code
#   /plugin marketplace add Exia-thd/DAI-memory-layer-plugin
#   /plugin install dai-memory
# ...rồi chạy setup một lần. `pnpm chat` in ra chỗ nó tìm thấy plugin ở dòng
# `[chat] memory server:`; cấu trúc thư mục marketplace khác nhau tuỳ hệ điều
# hành, nên hãy đọc đường dẫn đó thay vì đoán:
node <thư mục đó>/bin/setup.mjs

# Cách 3: tự clone
git clone https://github.com/Exia-thd/DAI-memory-layer-plugin
node DAI-memory-layer-plugin/bin/setup.mjs
```

`setup.mjs` cần mạng và tải khoảng 130 MB model. Chạy lại thì nó làm tiếp phần
còn thiếu.

**2. Tạo store cho project.** Plugin tìm store bằng cách đi ngược lên từ thư mục
làm việc, nên store nằm trong project chứ không nằm ở đây:

```bash
cd /path/to/your/project && dai-memory init

# Không có `dai-memory` trong PATH (clone tay thì không có):
cd /path/to/your/project && node /path/to/DAI-memory-layer-plugin/bin/dai-memory.mjs init
```

`pnpm chat` tự chạy lệnh này khi không thấy store.

**3. Chạy cửa sổ chat.** Một lệnh; nó tự tạo `plugin-mcp.json` nếu chưa có:

```bash
pnpm install && pnpm build
pnpm chat --dir /path/to/your/project --project myproject
```

Hoặc tự gõ đầy đủ từng biến:

```bash
cat > plugin-mcp.json <<'JSON'
{ "mcpServers": { "dai-memory": { "command": "dai-memory", "args": ["serve"] } } }
JSON

CORE_URL=none \
GATEWAY_DEV_SCOPE=me/me/myproject \
GATEWAY_MAX_CONCURRENCY=1 \
GATEWAY_EXTRA_MCP_CONFIG=./plugin-mcp.json \
GATEWAY_EXTRA_ALLOWED_TOOLS='mcp__dai-memory__*' \
GATEWAY_PROJECT_DIR=/path/to/your/project \
pnpm gateway
```

Danh sách tool cho phép là **cả server**, không phải liệt kê từng tool. Plugin
có hai mươi tool; viết tay năm cái bạn nhớ nghĩa là mười lăm cái còn lại bị từ
chối lúc gọi — mà một tool memory bị từ chối không làm model bỏ cuộc, nó làm
model quay sang đọc file của bạn. `mcp__<server>__*` là dạng chính thức và không
bao giờ lệch.

### Kiểm tra memory có thật sự chạy không

`pnpm chat` khởi động từng stdio server trong file MCP config, bắt tay MCP và
hỏi nó có tool gì, **trước khi** mở bất cứ thứ gì. Mấy dòng đầu nói hết:

```
[chat] DAI Brain e5e28e1
[chat] memory server: ~/dai-memory-layer-plugin/bin/dai-memory.mjs
[chat] dai-memory: 20 tools (dai_memory_search, dai_memory_why, dai_memory_get, dai_memory_neighbors, …)
[chat] project:  /path/to/your/project
[chat] http://localhost:8080
```

Dòng thứ ba mới là dòng quan trọng. Khi hỏng, thông báo của chính server được in
nguyên văn, và nó nói luôn cách sửa:

```
[chat] the dai-memory server did not start: it exited with code 1.
    The embedding model is not downloaded: config.json, tokenizer.json,
    tokenizer_config.json, onnx/model_quantized.onnx missing under
    ~/.memory/models/Xenova/paraphrase-multilingual-MiniLM-L12-v2.
    Run `node bin/setup.mjs` with network access.
[chat] the chat will open, but it will have no memory from dai-memory.
[chat] pass --no-probe to skip this check.
```

Server chết muộn hơn, hoặc chết sau khi đã qua được bước kiểm tra, thì bị bắt
giữa lượt chat: dòng khởi động của chính Claude báo trạng thái từng MCP server,
và trạng thái khác `connected` sẽ thành một thông báo đỏ trong khung chat, thay
vì một câu trả lời nhạt hơn mà không ai biết vì sao.

> The dai-memory MCP server did not connect (failed), so this answer is not
> grounded in memory.

Lượt đó cũng bị loại khỏi write-back. Memory không nên học từ một lượt không đọc
được memory.

| Bạn thấy gì | Nghĩa là gì |
|---|---|
| `dai-memory: 20 tools (…)` | memory đã sống, hỏi thoải mái |
| `did not start: it exited with code 1` | đọc thông báo in kèm — thường là chưa chạy `setup.mjs` |
| `did not start: it did not answer within 30s` | server bị treo; chạy tay đúng lệnh đó để xem vì sao |
| `connected but this session has no memory tools` | allow list đang gọi tên một server khác với server đang chạy |
| `No such tool available: Bash`, hoặc model đi đọc file | memory không với tới được nên model đi tìm chỗ khác |

Mở <http://localhost:8080>. Hội thoại nằm trong một file SQLite dưới session
root (dùng `node:sqlite`, không thêm dependency nào). Tab Memory tự biến mất, vì
không có Core phía sau để duyệt.

Trên Windows làm y hệt, chỉ thay biến inline bằng `set`, và thêm `CLAUDE_BIN`
nếu không dò được CLI — xem mục *Chạy trên Windows*.

Mỗi lượt chạy **trong đúng thư mục project bạn truyền vào `--dir`**, vì một
memory server dạng file tìm store bằng cách đi ngược lên từ đó. Thư mục tạm
riêng cho mỗi hội thoại đồng nghĩa nó không tìm thấy gì và báo là chưa có store.

Điều đó cũng có nghĩa model **đọc được** file trong thư mục đó. Hoá ra
`--allowedTools` là danh sách cho phép những tool vốn sẽ hỏi quyền, chứ không
phải hàng rào chặn mọi thứ còn lại — một lượt chạy thật ở đây đã gọi `Read` dù
nó không nằm trong danh sách. Đọc chính project của bạn từ một cửa sổ chat về nó
là hợp lý; ghi và thực thi thì không, nên `Bash`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit` và `KillShell` bị từ chối đích danh. Đổi danh sách bằng
`GATEWAY_DISALLOWED_TOOLS`.


### Giữ memory ngang bằng với code

Memory được dựng bằng một lượt scan, và không có tool MCP nào chạy được lượt
scan đó. Nên sau `git pull`, model trả lời về repo ở trạng thái của lần scan
gần nhất, mà **không có gì trong câu trả lời nói rằng nó đang cũ** — đây mới là
kiểu hỏng đáng sợ, vì một câu trả lời cũ mà tự tin thì đọc y hệt một câu đúng.

Hai lệnh, gõ thẳng trong khung chat:

```
/sync     quét lại project vào memory
/pull     git pull --ff-only, rồi bạn /sync
/help     ở đây đang có lệnh gì
```

Chúng chạy trong thư mục project, **không tốn tiền**, và **không đi qua model** —
Gateway tự chạy rồi đẩy output vào hội thoại. `/sync` vẫn chạy được cả khi hội
thoại đã chạm trần chi phí, đúng lúc người ta cần nó nhất.

`pull` tách riêng khỏi `sync`, và là `--ff-only`: một cửa sổ chat được phép
fast-forward một nhánh, nhưng không được tự ý tạo merge commit trong repo của
bạn. Muốn cả hai thì `/pull` rồi `/sync`.

Quét lại **không phá dữ liệu** — tôi kiểm chứng điều này trước khi xây tính năng.
Memory ghi từ chat vẫn còn nguyên; chỉ phần do scan sinh ra mới được dựng lại.
`dai-memory init --fresh` mới là lệnh xoá memory đã ghi, và không chỗ nào ở đây
chạy nó.

Lệnh đến từ `GATEWAY_COMMANDS`, một object JSON dạng tên → argv:

```json
{"sync": ["dai-memory", "ingest"], "pull": ["git", "pull", "--ff-only"]}
```

`pnpm chat` tự sinh ra nó từ memory server trong file MCP config, nên đổi lớp
memory là đổi chỗ đó chứ không phải đổi Gateway. Dùng argv chứ không dùng một
dòng lệnh, vì cách kia phải quote, mà quote chính là cách một đường dẫn có dấu
cách biến thành hai tham số trên đúng cái hệ điều hành hay có dấu cách trong
đường dẫn.

Một tin nhắn chỉ chọn được **cái tên**. `/sync --force` hay `/sync; rm -rf /`
không phải là lệnh — chúng là tin nhắn bình thường, và đi tới model dưới dạng
chữ.

### Đính kèm file

Khung soạn nhận file: nút **＋**, kéo thả vào đó, hoặc dán. File được ghi cạnh
hội thoại, trong `<session root>/<conversation id>/uploads/`, rồi model được cho
biết đường dẫn và được yêu cầu đọc.

Cạnh hội thoại, **không** ghi vào thư mục project: `--dir` trỏ vào repo của
chính bạn, và một cửa sổ chat không có quyền để lại file trong đó. Hệ quả là
file nằm ngoài thư mục làm việc của CLI, nên Gateway truyền thêm
`--add-dir <thư mục đó>` — thiếu cờ này thì lệnh đọc bị từ chối với thông báo
trông y như file không tồn tại.

Giới hạn, đều chỉnh được:

| | Mặc định | Biến |
|---|---|---|
| Số file mỗi tin nhắn | 10 | `GATEWAY_MAX_ATTACHMENTS` |
| Tổng dung lượng mỗi tin nhắn | 5 MB | `GATEWAY_MAX_ATTACHMENT_BYTES` |

5 MB sau giải mã tương đương khoảng 6.7 MB base64, vừa dưới mức 8 MB body của
router. Đặt cao hơn thì giới hạn thành vô nghĩa: request bị từ chối vì quá lớn
trước khi có ai đếm tới phần đính kèm.

Tên file không bao giờ được tin. Nó đến từ request body và sắp được ghép vào một
đường dẫn, nên dấu phân cách, ký tự điều khiển và dấu chấm đầu bị loại bỏ trước
khi nó được dùng làm tên — `../../etc/passwd` thành `etcpasswd`, nằm trong đúng
thư mục uploads của hội thoại đó. Hai file trùng tên thành `log.txt` và
`log-2.txt` chứ không đè lên nhau.

File đính kèm nằm lại trên đĩa suốt vòng đời hội thoại, nên lượt sau resume cùng
session vẫn đọc được.

### Bạn mất gì, và tại sao

| | Bản đầy đủ | Bản cá nhân |
|---|---|---|
| Postgres | bắt buộc | không cần |
| Brain Core, Brain MCP | bắt buộc | không cần |
| Hội thoại | Postgres | file SQLite |
| Memory | hybrid retrieval của Core | của plugin |
| Pre-fetch trước lượt đầu | có | không — model tự gọi tool |
| Citation chip | có | không |
| Write-back (tự học từ chat) | có | không |
| Chat đồng thời | tới `GATEWAY_MAX_CONCURRENCY` | một |

Concurrency bằng một vì store của plugin là embedded và chỉ nhận một writer; hai
tiến trình `claude -p` song song sẽ đụng nhau.

Ba dòng vắng mặt phía trên thực ra là cùng một thứ: pre-fetch, citation và
write-back đều là Brain Core tự đọc/ghi memory, mà ở đây Gateway không nhìn thấy
memory chút nào — chỉ model nhìn thấy, qua tool của nó.

**`CORE_URL=none` cũng bỏ luôn Brain MCP**, một cách có chủ ý. Khai báo một MCP
server không chạy còn tệ hơn là không khai báo: model thấy kết nối lỗi rồi bắt
đầu giảm tin tưởng vào chính memory mà nó nhận được. Đây không phải suy đoán —
nó đã nói đúng như vậy trong câu trả lời lúc tôi test.

### Trước khi bạn build bất cứ thứ gì ở trên

Nếu terminal là đủ thì bạn không cần gì cả. `/plugin install dai-memory` cho bạn
memory ngay trong Claude Code hôm nay, không Gateway, không UI, không database.
Phần setup ở trên chỉ đáng bỏ công nếu bạn thật sự muốn cái cửa sổ chat.


## Nó tốn bao nhiêu, và cái gì chặn lại

Mỗi tin nhắn spawn nguyên một phiên Claude CLI. Đó là tiền thật trừ vào tài
khoản thật, và cần nói thẳng ra vì trong chính quá trình test dự án này, nó đã
âm thầm tiêu hết quota subscription của tác giả cho tới lúc chạm giới hạn.

Ba thứ rút ra từ đó, và cả ba giờ đều bật mặc định:

- **Trần chi phí cho mỗi hội thoại.** `GATEWAY_MAX_CONVERSATION_COST_USD` mặc
  định `5`. Vượt trần, Gateway từ chối lượt đó **trước khi** spawn bất cứ thứ gì
  — vì sau khi tiến trình chạy thì tiền đã tiêu rồi. Tính theo từng hội thoại
  chứ không phải toàn cục, vì một vụ chạy loạn gần như luôn là một hội thoại bị
  lặp, mà trần toàn cục sẽ kéo sập mọi thứ còn lại. Đặt `0` để tắt.
- **Mỗi lượt đều được ghi lại**, theo từng lượt chứ không phải tổng, vì một con
  số tổng không trả lời được câu duy nhất người ta hỏi sau đó: hội thoại nào đã
  chạy loạn. UI hiện chi phí đang chạy ở thanh trạng thái, và chuyển sang màu
  cam khi vượt 80% trần.
- **Hai cảnh báo lúc khởi động.** Không đặt `CLAUDE_MODEL` nghĩa là mọi lượt
  chạy bằng model mặc định của CLI — model đắt nhất. Không đặt
  `ANTHROPIC_API_KEY` nghĩa là runner tính tiền vào tài khoản mà CLI đang đăng
  nhập, với hầu hết mọi người chính là subscription của họ.

Cho một cửa sổ chat cá nhân:

```bash
export ANTHROPIC_API_KEY=...          # tách billing khỏi quota của chính bạn
export CLAUDE_MODEL=claude-sonnet-5   # hoặc rẻ hơn
```

API key quan trọng ngay cả khi chỉ một người dùng: nó khiến một con bug trong
Gateway không thể khoá bạn khỏi chính Claude Code mà bạn đang dùng để sửa nó.

**Write-back nhân đôi hoá đơn** — thêm một lần gọi model cho mỗi hội thoại. Nó
tắt sẵn ở chế độ cá nhân và bật ở bản đầy đủ; đặt `GATEWAY_WRITEBACK=false` để
tắt luôn ở bản đầy đủ.


## Tại sao lại cần database

Plugin mà cái này lớn lên từ đó không cần server: nó lưu mọi thứ thành file
ngay trong thư mục project. Đó là câu trả lời đúng cho hình dạng của nó — một
người, một máy, một checkout.

DAI Brain là hình dạng khác, và chính khác biệt đó là cái khiến bạn phải trả giá
bằng một database:

- **Nó nhiều người dùng ngay từ thiết kế.** Scope là `tenant → user → project`,
  và bộ test cách ly tồn tại vì memory của nhiều người nằm chung một store.
- **Hai tiến trình cùng ghi vào nó.** Core giữ memory; Gateway giữ hội thoại,
  session id của Claude và hàng đợi write-back. Một store dạng file nhúng không
  cho hai tiến trình ghi đồng thời.
- **Hàng đợi cần khoá thật.** Worker write-back nhận job bằng
  `FOR UPDATE SKIP LOCKED`, nên chạy worker thứ hai vẫn an toàn mà không cái nào
  cần biết cái kia tồn tại.
- **Gateway cố tình stateless** để chạy được nhiều instance. Điều đó chỉ đúng khi
  state nằm ở nơi cả hai instance đều thấy.

Nếu bạn chỉ muốn memory cho riêng mình trên một máy, thì đó là cái giá thật cho
một lợi ích không có, và plugin mới là công cụ đúng cho hình dạng đó. Hai bên
không cạnh tranh nhau — xem mục *Mồi dữ liệu từ một repository* để chạy song song.

### pgvector là tuỳ chọn

Bạn cần Postgres. Bạn **không** cần pgvector. Không có nó thì cột embedding là
`real[]` và nhánh vector quét chính xác — tuyến tính theo số item, và nó nói rõ
điều đó trong fusion report lẫn `/health` chứ không giả vờ.

Đo trên bộ eval, với store cỡ này:

| | recall@10 | MRR@10 | p95 |
|---|---|---|---|
| có pgvector (HNSW) | 90.7% | 0.839 | 7ms |
| không, quét chính xác | 89.6% | 0.834 | 9ms |

Toàn bộ test pass ở cả hai chế độ. Chênh lệch nằm trong nhiễu giữa các lần chạy ở
mức 40 item; cái khác nhau là đường cong khi lớn lên, không phải câu trả lời —
quét chính xác thì đúng ở mọi kích cỡ và chậm ở kích cỡ lớn.

Muốn tự kiểm chứng đường fallback trên máy đã cài sẵn pgvector:

```bash
DAI_DISABLE_PGVECTOR=true pnpm migrate
```

Một đường fallback chưa ai chạy là đường fallback không ai nên tin.


## Một câu hỏi được trả lời như thế nào

1. UI gọi `POST /chat`. Gateway verify JWT rồi quyết định scope. Đây là nơi duy
   nhất scope được quyết định.
2. Pre-fetch: gọi Core `/search` với budget khoảng 1000 token. Kết quả được đưa
   vào `--append-system-prompt`, nên lượt đầu tiên đã có memory trước cả khi
   model nghĩ đến chuyện đi tìm.
3. Gateway spawn `claude -p` với memory MCP server đã nối sẵn, và
   `--allowedTools` giới hạn đúng bốn tool memory.
4. Claude có thể gọi thêm `memory_search`. MCP forward sang Core kèm scope mà
   Gateway đã đặt — model không nhìn thấy header đó và không đổi được nó.
5. Stream translator map `stream-json` của Claude sang sáu SSE event. Tool
   result từ `mcp__memory__*` trở thành event `citation`.
6. Khi lượt chat kết thúc sạch sẽ, transcript được đẩy vào hàng đợi write-back.

## Chạy trên Windows

Có hai chỗ khác, và một trong hai sẽ chặn bạn ngay nếu không xử lý.

**Node không spawn được file `.cmd` của Claude CLI.** Kể từ bản vá
CVE-2024-27980, `spawn` từ chối `.cmd` nếu không có `shell: true` — mà ở đây
không được dùng shell: prompt là thứ người dùng gõ vào và nó đi trong argv, nên
dưới cmd.exe một câu chat sẽ biến thành câu lệnh. Gateway bước qua file shim đó
và chạy thẳng entry point JavaScript của CLI bằng Node. Nó tự tìm entry này
trong bố cục npm global thông thường; khi không tìm được, nó báo lỗi kèm hướng
dẫn chứ không ném ra `ENOENT`:

```cmd
npm root -g
set CLAUDE_BIN=%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js
```

**Thư mục session** mặc định nằm ở `%TEMP%\dai-brain-sessions`, không phải
`C:\tmp`. Đổi bằng `GATEWAY_SESSION_ROOT` nếu bạn muốn nơi lưu lâu dài.

### Cách chạy local đơn giản nhất

Chạy service bằng Docker, còn CLI ingest chạy trên máy thật. Docker Desktop chạy
container Linux nên vấn đề spawn không hề phát sinh, và CLI ingest thì không bao
giờ spawn Claude CLI:

```cmd
cd infra
copy .env.example .env
docker compose up -d

REM Mồi memory từ một project trên ổ đĩa của bạn.
cd ..
pnpm install
pnpm build
set DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain
pnpm ingest:repo C:\Project\Inventory --scope acme/me/inventory --dry-run
pnpm ingest:repo C:\Project\Inventory --scope acme/me/inventory
```

Sau đó đặt scope của Gateway về đúng project đó rồi mở <http://localhost:8080>.
Với `GATEWAY_DEV_SCOPE=acme/me/inventory` trong `infra/.env`, mọi request sẽ
chạy dưới user và project đó.

Chạy `--dry-run` trước rất đáng bỏ thêm một phút: nó in ra những gì sẽ được lưu,
và một repo không có ADR, không có `CONTRIBUTING`, không có `CLAUDE.md`, commit
message cụt lủn thì sẽ ra rất ít. Đó là ingester làm đúng — nó đọc *lý luận*, và
một repo chưa từng viết lý luận ra thì không có gì để đưa.

### Hoặc chạy hết native

Vẫn được, với `CLAUDE_BIN` đặt như trên. Nhớ dùng Postgres có pgvector — image
chính thức `pgvector/pgvector:pg16` là đường ít phiền nhất kể cả khi phần còn
lại chạy trên máy thật.


## Dùng DAI Brain từ Claude Code của chính bạn

Gateway tự viết MCP config cho các session nó spawn, nên web UI không cần cấu
hình gì. Còn để truy cập cùng bộ memory đó từ CLI `claude` trong terminal của
bạn, bạn phải tự đăng ký MCP server.

Core và MCP phải chạy trước (`pnpm core` và `pnpm mcp`, hoặc `docker compose up`
trong `infra/`).

### Cách A — một lệnh, chỉ cho riêng bạn

```bash
pnpm mcp:add --scope acme/me/daibrain
```

Hoặc khi không có sẵn repo này:

```bash
claude mcp add --transport http dai-brain http://localhost:8082/mcp \
  --header "X-Scope: acme/me/daibrain"
```

Thêm `--user-scope` (hoặc `-s user` nếu gõ lệnh gốc) để dùng được ở mọi thư mục
chứ không chỉ thư mục hiện tại.

Kiểm tra lại:

```bash
claude mcp list
# dai-brain: http://localhost:8082/mcp (HTTP) - ✓ Connected
```

### Cách B — config commit vào repo, cho cả team

File `.mcp.json` đã có sẵn trong repo này:

```json
{
  "mcpServers": {
    "dai-brain": {
      "type": "http",
      "url": "${DAI_BRAIN_MCP_URL:-http://localhost:8082/mcp}",
      "headers": { "X-Scope": "${DAI_BRAIN_SCOPE}" }
    }
  }
}
```

Mọi người dùng chung file; mỗi người tự đặt scope của mình:

```bash
export DAI_BRAIN_SCOPE=acme/ten-cua-ban/daibrain
```

Copy file này sang repo khác là dùng được cùng bộ memory khi làm việc ở đó.

`.claude/settings.json` chỉ đích danh server này trong `enabledMcpjsonServers`,
nên nó load mà không cần hỏi. Đây là lựa chọn hẹp hơn `enableAllProjectMcpServers:
true` một cách có chủ ý — approve *server này* là quyết định về một file bạn đọc
được, còn approve tất cả là lời hứa cho mọi `.mcp.json` mà ai đó thêm vào sau này.
Nếu không có setting, chạy `claude` một lần ở chế độ interactive và bấm approve.

### Header scope là bắt buộc

`X-Scope` có dạng `tenant/user/project` (đặt `*` ở ô project để đọc xuyên suốt
mọi project của bạn). MCP server **từ chối request không có header này** thay vì
tự chọn giá trị mặc định — vì lựa chọn còn lại là đoán xem bạn muốn memory của
ai, đúng cái lỗi đọc chéo user mà toàn bộ scope model sinh ra để chặn.

Nếu `DAI_BRAIN_SCOPE` chưa được set, CLI báo thẳng và không load server:

```
[Warning] [dai-brain] mcpServers.dai-brain: Missing environment variables: DAI_BRAIN_SCOPE
```

### Vài chỗ sẽ làm bạn bối rối đúng một lần

- **Tên server quyết định tiền tố của tool.** Đặt tên `dai-brain` thì tool là
  `mcp__dai-brain__memory_search`. Đặt tên `memory` thì trùng với cái Gateway
  cho phép (`mcp__memory__*`). Kiểu nào cũng được — miễn là khớp với thứ bạn
  truyền vào `--allowedTools`.
- **`claude mcp list` hiện project server là "Pending approval"** ngay cả khi nó
  đang chạy tốt. Lệnh list đó không đọc `enableAllProjectMcpServers`, còn session
  thật thì có. Hãy kiểm tra bằng một lần chạy thật, đừng tin cái list.
- **Đây là cổng của MCP (8082), không phải của Gateway (8080).** CLI nói chuyện
  thẳng với MCP. Nó lấy được memory, nhưng không có pre-fetch, lịch sử hội thoại
  hay write-back của Gateway — những thứ đó thuộc về giao diện chat.

### Dùng trong script

Để ghim đúng một server và bỏ qua mọi thứ khác đang cấu hình trên máy, giống
cách Gateway làm:

```bash
cat > /tmp/dai-mcp.json <<'JSON'
{ "mcpServers": { "memory": { "type": "http", "url": "http://localhost:8082/mcp",
  "headers": { "X-Scope": "acme/me/daibrain" } } } }
JSON

claude -p "hồi trước mình chốt dùng database nào?" \
  --mcp-config /tmp/dai-mcp.json --strict-mcp-config \
  --allowedTools "mcp__memory__memory_search,mcp__memory__memory_write"
```

`--strict-mcp-config` là cờ quan trọng nhất: thiếu nó, CLI sẽ trộn thêm các MCP
server vốn có của máy vào session.

## Cho UI dùng thêm tool khác (Jira, v.v.)

Thêm server vào CLI của bạn bằng `claude mcp add` **không** làm nó xuất hiện
trong web UI. Gateway tự viết config riêng và truyền `--strict-mcp-config`, cố
tình bỏ qua mọi MCP server cấu hình trên máy host — nếu không thì thứ mà một
lập trình viên nào đó từng `claude mcp add` sẽ âm thầm chui vào session đang
phục vụ người khác.

Nên server phụ do người vận hành khai báo, trong một file:

```bash
cat > /etc/dai-brain/extra-mcp.json <<'JSON'
{
  "mcpServers": {
    "jira": {
      "type": "http",
      "url": "https://your-jira-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
JSON

export GATEWAY_EXTRA_MCP_CONFIG=/etc/dai-brain/extra-mcp.json
export GATEWAY_EXTRA_ALLOWED_TOOLS="mcp__jira__search_issues,mcp__jira__get_issue"
```

Cả hai đều bắt buộc. `--allowedTools` không có wildcard cho MCP nên phải liệt kê
tên tool — và đó không chỉ là hạn chế phải lách: danh sách đó chính là bản ghi
để audit xem một agent phục vụ web được phép làm gì. Server khai báo mà không
liệt kê tool thì không ai gọi được, và đó là hướng fail an toàn.

Ba điều nó cố tình làm:

- **`memory` không thể bị chiếm chỗ.** Server phụ được merge *bên dưới* nó. Một
  file config định nghĩa lại `memory` sẽ trỏ các tool memory sang endpoint của
  người khác, và endpoint đó sẽ nhận được header scope của user ở lần search kế
  tiếp.
- **Header scope không rò ra ngoài.** `X-Scope` chỉ được ghi lên server memory.
  Entry Jira mang credential gì là việc của người vận hành, và nó giống nhau cho
  mọi user.
- **File thiếu hoặc sai định dạng sẽ làm fail lượt chat, một cách ồn ào.** Người
  vận hành đã cấu hình Jira mà nhận được session không có Jira sẽ ngồi debug
  prompt cả tiếng trước khi nghĩ tới file config.

**Không** hỗ trợ credential riêng cho từng user: file này là một bộ server dùng
chung cho mọi người mà Gateway phục vụ. Nếu Jira phải hành động với tư cách từng
cá nhân thay vì một service account, thì cần inject credential theo từng
request — phần đó chưa làm.


## Mồi dữ liệu từ một repository

Store mới tinh thì không biết gì, mà memory hội thoại chỉ tích lũy được bằng
cách... trò chuyện. Trong khi đó một repository đã chứa sẵn hàng tháng lý luận —
chỉ là chưa ở dạng nào truy xuất được.

```bash
pnpm ingest:repo /duong/dan/repo --scope acme/me/myproject --dry-run   # xem trước
pnpm ingest:repo /duong/dan/repo --scope acme/me/myproject
```

Nó đọc đúng phần **không** thể tái tạo bằng cách đọc code: ADR, CONTRIBUTING,
CLAUDE.md, tài liệu kiến trúc, những đoạn README thực sự lập luận cho một lựa
chọn, và commit message có phần body. Ý đồ của file quyết định type (ADR là
`decision`, CLAUDE.md là `preference`), còn một section có lập luận thì được
nâng lên `decision` dù nó nằm ở file nào.

Mọi thứ đi qua đường ghi bình thường, nên privacy filter và reconciler đều có
hiệu lực. Chạy lại nhiều lần là an toàn: section không đổi trả về `duplicate`,
section đã sửa sẽ supersede bản cũ. Mỗi item giữ nguyên nguồn gốc —
`repo:docs/adr/0001-use-rrf.md#use-rrf`, `git:3d05af4c9579`.

### Cái nó cố tình không làm

Nó không index code. Symbol, call graph và cấu trúc file là **dữ liệu dẫn
xuất**: stale ngay ở commit kế tiếp, mà một agent đang có repo trong tay thì đọc
thẳng được và nhận câu trả lời của hôm nay thay vì của tuần trước.

Nếu bạn muốn hỏi về cấu trúc code — hàm này ai gọi, sửa chỗ này thì hỏng chỗ nào
— thì [DAI memory layer plugin](https://github.com/Exia-thd/DAI-memory-layer-plugin)
đã làm việc đó cho 29 ngôn ngữ, và hai hệ chạy song song được như hai MCP server
riêng. Claude sẽ có `mcp__dai-brain__memory_*` cho memory hội thoại xuyên
project, và `dai_memory_*` cho code graph của repo hiện tại.

### Tại sao là CLI chứ không phải endpoint

Một HTTP endpoint nhận đường dẫn filesystem phía server sẽ cho phép bất kỳ ai
cầm token biến mọi file mà tiến trình Core đọc được thành một memory rồi truy
xuất lại — lộ file tùy ý, khoác áo một API ingestion. Người vận hành chạy CLI
thì vốn đã có filesystem rồi, nên nó không trao thêm quyền gì.


## Retrieval

`POST /search` chạy năm bước:

| Bước | Làm gì | Tại sao cần |
|---|---|---|
| Vector | pgvector ANN, hoặc quét chính xác nếu không có extension | Khái quát hóa qua cách diễn đạt khác nhau |
| Graph | Entity-link câu hỏi, mở rộng 1–2 hop | Tìm cái *liên quan*, không chỉ cái giống chữ |
| FTS | Postgres `tsvector`, config `simple` | Định danh chính xác, tên flag, số phiên bản |
| RRF | Reciprocal rank fusion, có trọng số | Ba điểm số không chung thang đo; chỉ thứ hạng là chung |
| Rerank | Tùy chọn, nằm sau một interface | RRF chỉ biết thứ hạng, nên không phân biệt được decision với note |

Ba nhánh chạy song song và mỗi nhánh tự bắt lỗi của mình, nên một nhánh hỏng chỉ
làm giảm recall chứ không làm hỏng cả request. Nhánh nào không đóng góp gì đều bị
gọi tên trong fusion report kèm lý do:

```json
"fusion": {
  "branches": { "vector": 7, "fts": 1, "graph": 0 },
  "degraded": ["graph"],
  "reasons": { "graph": "no entity in this scope matched the query text" }
}
```

Một nhánh trả về rỗng mà không nói gì chính là cách hệ hybrid âm thầm thoái hóa
thành "còn nhánh nào chạy được thì dùng nhánh đó". Memory explorer hiển thị
report này cho mọi lần search, nên đó là cách nhanh nhất để chẩn đoán recall kém.

### Index vector

HNSW, không phải IVFFlat, và khác biệt này không phải chuyện sở thích.

IVFFlat phải được *huấn luyện*: nó gom các vector đang có trong bảng thành
`lists` cụm, và một truy vấn với `probes = 1` mặc định chỉ quét đúng **một**
cụm. Tạo lúc migrate thì bảng còn trống, nên tâm cụm vô nghĩa. Đo trên store 62
item, index IVFFlat khi được planner chọn trả về **1 dòng trên 62**, trong khi
quét chính xác trả đủ 62 — và nó vẫn báo mình hoàn toàn khỏe mạnh.

Đó là dạng bug tệ nhất ở đây: nhánh không hề fail nên không bao giờ bị đánh dấu
degraded, và mọi con số recall đo phía sau đều đang đo trên một phần nhỏ của
store.

HNSW không cần dữ liệu huấn luyện, nên nó đúng ngay cả khi bảng trống và vẫn
đúng khi store lớn dần mà không ai phải chỉnh lại `lists` với `probes`. Dưới
pgvector 0.5 thì không có HNSW, và migration sẽ **không** tạo index nào cả: quét
chính xác tuy tuyến tính nhưng đầy đủ, đó là đánh đổi đúng.

`pnpm migrate` sửa được database đã có — migration `002` xoá index cũ và dựng
lại. `/health` sẽ báo `degraded` nếu còn gặp index IVFFlat, kèm cách sửa.


### Packer theo token budget

`maxTokens` là trần cứng. Không item nào được chiếm quá 35% budget, nên một
artifact dài không thể đè mất năm decision ngắn, và packer vẫn chạy tiếp qua item
không vừa. Mọi thứ bị bỏ đều được đếm trong `omitted` — một cái limit chỉ trả lời
"bao nhiêu", không bao giờ trả lời "có tất cả bao nhiêu".

## Đánh giá (eval)

```bash
pnpm eval              # một cấu hình, kèm những câu nó trả lời trượt
pnpm eval --compare    # chỉ vector vs. đủ nhánh vs. graph 2 hop vs. rerank
```

45 câu hỏi được chấm bằng tay trên corpus 40 item, cả tiếng Anh lẫn tiếng Việt,
nằm trong `eval/data/`. Trường `relevant` liệt kê những item thực sự trả lời được
câu hỏi — chấm bằng tay, tuyệt đối không lấy từ output của retriever, vì một bộ
eval dựng từ chính output của nó thì chẳng đo được gì.

Số liệu hiện tại, chạy trên embedder **hash** (xem bên dưới — đây là mức sàn):

```
đủ nhánh, không rerank       recall@5 84.4%   recall@10 90.7%
                             MRR@10 0.839     p95 7ms
chỉ vector+fts (tắt graph)   recall@5 81.1%   recall@10 89.6%   MRR@10 0.804
đủ nhánh, graph 2 hop        recall@5 84.4%   recall@10 89.6%   MRR@10 0.838
đủ nhánh + rerank            recall@5 82.2%   recall@10 88.5%   MRR@10 0.847
```

Nghĩa là graph expansion đáng giá khoảng 4 điểm MRR ở 1 hop và không thêm gì ở
2 hop, còn reranker đánh đổi một chút nDCG lấy một chút MRR. Đó chính là loại con
số mà trọng số các nhánh nên dựa vào để thay đổi.

Chênh lệch khoảng ±1 điểm giữa các lần chạy là bình thường: `ivfflat` là index
gần đúng, và hành vi của nó thay đổi theo những gì đang có trong bảng. Coi mức
dịch 1 điểm là nhiễu, 5 điểm mới là kết quả.

Hai câu còn trượt đều cần khả năng khái quát ngữ nghĩa mà hash embedder không có
("nên viết service mới bằng ngôn ngữ gì?" → một memory nói *TypeScript* nhưng
không hề có chữ *ngôn ngữ*). Đó đúng là phần việc của một embedder thật.

Cho CI, thêm `--min-recall 0.85 --max-p95 500` để lệnh fail thay vì chỉ in số.

## Embeddings

Mặc định là `hash`: tất định, chạy offline, không tải gì, nên vừa clone về là
chạy được cả hệ lẫn eval. Nhưng nó thuần từ vựng — hai cách diễn đạt không chung
chữ nào sẽ nằm rất xa nhau. **Recall đo trên nó là mức sàn, không phải dự báo.**

```bash
DAI_EMBEDDING_PROVIDER=transformers DAI_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
```

`DAI_EMBEDDING_DIMS` phải khớp với model và được **cố định ngay lúc migrate**, vì
đó là độ rộng của cột `vector(N)`. Đổi nó sau khi đã có dữ liệu thì phải tạo store
mới và ingest lại.

## Scope

`tenant → user → project`. Mọi query đều mang một scope, và **scope không bao giờ
đến từ model**.

- Gateway quyết định nó, từ JWT claim đã verify, trong `scopeFor()`.
- Nó đi theo header `X-Scope: tenant/user/project` (`*` nghĩa là mọi project).
- Core tin tuyệt đối header đó — điều này chỉ đúng khi Gateway là thứ duy nhất
  gọi được tới Core. Trong `infra/docker-compose.yml`, chỉ Gateway mở cổng ra
  ngoài.
- `scopeWhere()` là cách duy nhất một scope trở thành SQL. Không có biến thể nào
  nhận scope tùy chọn.
- ID của entity được suy ra từ scope, nên hai user cùng viết về "Deployment" sẽ
  có hai node riêng, không phải một node dùng chung.
- Cache search có scope trong khóa. Một cache chỉ khóa theo câu hỏi là cách rò rỉ
  chéo user rẻ nhất, và nó vượt qua mọi bài test chạy với một user.

`tests/scope-isolation.test.js` kiểm tra toàn bộ những điều trên.

## Write-back

Gateway đẩy transcript vào hàng đợi → worker nhận job (`FOR UPDATE SKIP LOCKED`)
→ một model rẻ trích xuất các fact ứng viên → privacy filter chạy → reconciler
quyết định.

Bốn kết quả: `rejected` (dính secret, hoặc confidence dưới ngưỡng), `duplicate`
(trùng nội dung sau khi chuẩn hóa), `superseded` (có item gần giống vượt ngưỡng
similarity — item cũ bị đánh dấu, không bị xóa), `inserted`.

**Undo.** Mọi item do write-back tạo ra đều mang `conversation_id`, nên:

```bash
curl -X DELETE localhost:8080/conversations/conv_abc/memory
```

xóa sạch những gì một lần chạy tạo ra, và không đụng vào thứ do người viết tay.

Hãy bắt đầu chặt tay. `GATEWAY_WRITEBACK_MIN_CONFIDENCE=0.6` là cái sàn để nới ra
khi có bằng chứng, không phải con số để hạ xuống chỉ vì thấy store trông hơi rỗng.

## Privacy filter

API key của các provider, khối private key và JWT sẽ **loại bỏ cả item**. Secret
dạng gán giá trị (`DB_PASSWORD=…`), mật khẩu trong database URL, bearer token và
email thì bị **che**, giữ lại câu văn và bỏ đi giá trị. Số thẻ chỉ bị che khi qua
được kiểm tra Luhn, để chuỗi phiên bản và timestamp không bị ăn oan.

Một secret nằm trong memory còn tệ hơn nằm trong log: nó sẽ được truy xuất, gói
vào system prompt, và gửi tới model ở mọi câu hỏi sau này có nét giống câu đã
bắt được nó.

## Test

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain_test
pnpm migrate
pnpm test
```

Các test cần database sẽ tự skip khi không có, thay vì fail. Mỗi test nhận một
project scope mới tinh, nên chúng không bao giờ nhìn thấy dữ liệu của nhau.

## Cấu hình

**Core** — `DATABASE_URL`, `CORE_PORT`, `DAI_EMBEDDING_PROVIDER`,
`DAI_EMBEDDING_MODEL`, `DAI_EMBEDDING_DIMS`, `DAI_SEARCH_MAX_TOKENS`,
`DAI_SEARCH_LIMIT`, `DAI_GRAPH_DEPTH`, `DAI_DEDUPE_THRESHOLD`,
`DAI_SEARCH_CACHE_TTL_MS`, `DAI_DISABLE_PGVECTOR`.

**Gateway** — `GATEWAY_PORT`, `CORE_URL`, `MCP_URL`, `CLAUDE_BIN`,
`CLAUDE_MODEL`, `GATEWAY_MAX_CONCURRENCY`, `GATEWAY_REQUEST_TIMEOUT_MS`,
`GATEWAY_SESSION_ROOT`, `GATEWAY_PREFETCH_TOKENS`, `GATEWAY_JWT_SECRET`,
`GATEWAY_DEV_SCOPE`, `GATEWAY_WRITEBACK*`, `GATEWAY_EXTRA_MCP_CONFIG`,
`GATEWAY_EXTRA_ALLOWED_TOOLS`, `GATEWAY_SQLITE_PATH`,
`GATEWAY_MAX_CONVERSATION_COST_USD`, `GATEWAY_MAX_ATTACHMENTS`,
`GATEWAY_MAX_ATTACHMENT_BYTES`, `GATEWAY_COMMANDS`. Bỏ trống `DATABASE_URL`
sẽ dùng store SQLite; `CORE_URL=none` bỏ luôn Brain Core và Brain MCP.

**MCP** — `MCP_PORT`, `CORE_URL`.

### Xác thực cho CLI

Nếu DAI Brain phục vụ nhiều hơn một người, hãy cho CLI chạy bằng
`ANTHROPIC_API_KEY` thay vì đăng nhập bằng subscription cá nhân: tiến trình này
phục vụ bất kỳ ai cầm token, còn subscription thì cấp cho một con người cụ thể.
Hãy kiểm tra lại điều khoản của Anthropic cho trường hợp của bạn.

## Hạn chế đã biết

- **Nhánh vector không có ngưỡng similarity.** Nó là k-nearest, nên luôn trả về
  đủ `k` hàng xóm dù chẳng liên quan gì. RRF và token budget có giảm nhẹ chuyện
  này, nhưng thêm một ngưỡng là một nút chỉnh thật sự — và nên để eval quyết định
  chứ không phải cảm tính.
- **Reranker mới chỉ là heuristic**, chưa phải cross-encoder: nó trộn độ phủ câu
  hỏi, loại memory và độ mới. `Reranker` là interface để một model thật thay vào;
  eval sẽ nói cho bạn biết độ trễ đó có đáng không.
- **Relation mới chỉ là đồng xuất hiện.** `RELATES_TO` nghĩa là các tên này cùng
  xuất hiện trong một memory. Chưa có gì suy ra được chúng liên quan *như thế nào*.
- **Write-back chưa có tác vụ quét định kỳ.** Nó chạy theo từng hội thoại; chưa có
  pass chạy nền để gộp hay làm suy giảm memory xuyên nhiều hội thoại.
- **Chưa có memory decay.** Độ mới mới chỉ là một thành phần trong reranker, chưa
  phải tiến trình nền hạ dần vị thế của các item cũ, ít dùng.
- **UI không render markdown.** Câu trả lời được chèn bằng `textContent`, nên
  `**đậm**` sẽ hiện ra cả dấu sao. Đó là mặc định an toàn cho văn bản do model
  sinh ra; muốn render thì cần một parser có sanitize, không phải một cái regex.
- **Observability mới chỉ là log ra console.** Phần tracing mà kế hoạch mong muốn
  (Langfuse hoặc OpenTelemetry xuyên pre-fetch, tool call, token và latency) chưa
  được làm.

## Giấy phép

MIT.
