# 轻排班（ShiftLite）

面向中小餐饮、零售及服务业团队的**排班与工时统计工具**。解决手工/Excel 排班的四类痛点：
排班冲突靠人工发现、员工可用时间难记全、全职与兼职工时规则混用、工时汇总繁琐易错。

> 高校竞赛“技术创新赛道—软件开发与应用创新方向”参赛项目（技术原型 v1.0）。

## 功能一览

- **员工管理**：岗位、全职/兼职、可排班日与每日可用时段、在职状态（有排班记录者删除时转为停用）
- **班次模板**：常用班次一键套用，支持跨日班次（如打烊班 19:00–01:00）与班内休息
- **排班编制**：周视图网格（员工 × 周一至周日），点格新增、点芯片编辑/删除、周导航；显示每日人数/班次数与员工周工时，支持预检后复制上周排班
- **冲突检测**（五类规则，全部可配置）：
  | 规则 | 级别 | 默认值 |
  | --- | --- | --- |
  | 班次重叠 | 错误（保存需二次确认） | — |
  | 可用时间冲突 | 错误 | — |
  | 班间休息不足 | 提示 | 间隔 ≥ 10 小时 |
  | 每日工时上限 | 提示 | 全职 10h / 兼职 8h |
  | 每周工时上限 | 提示 | 全职 44h / 兼职 24h |
- **工时统计**：按日/周/月汇总，有效工时 = 排班时长 − 班内休息；跨日班次计入开始日期所在周期
- **报表导出**：排班表 / 工时统计表（含逐日列与合计行）导出 .xlsx
- **密码登录**：单管理员账号，PBKDF2 加盐哈希存储，登录失败限速（15 分钟 5 次），设置页可修改密码
- **品牌外观**：系统标题与品牌头像可在“设置”页调整，同步用于侧边栏、浏览器标签与站点图标
- **数据管理**：本地 SQLite 单文件存储、一键下载备份、演示数据重置

界面遵循 **Material 3（Material You）** 设计语言，米 beige 主题，中文界面，兼顾小屏浏览。

## 环境要求

- Python ≥ 3.10（开发验证使用 3.14）
- 无需联网、无前端构建步骤；浏览器使用 Chrome / Edge / Firefox 均可

## 本地运行（开发 / 单机使用）

```bash
pip install -r requirements.txt
python seed.py            # 首次运行写入演示数据（python seed.py --force 重置）
python app.py             # 启动后访问 http://127.0.0.1:5001（默认密码 shiftlite123）
```

> **登录**：打开即要求输入管理员密码，演示默认密码 `shiftlite123`，登录后请在
> 「设置 → 账号安全」修改。密码以 PBKDF2（200k 轮）加盐哈希存储。

运行测试与性能测量：

```bash
pip install pytest
python -m pytest tests/           # 58 项单元 + 功能测试
python scripts/benchmark.py       # 需服务已启动；结果写入 docs/perf-results.md
```

---

## 部署方式

系统提供四种部署形态：**Cloudflare Workers（云端，免运维）**、**Python 云服务器**（主实现的
传统部署，完全自主可控）、Docker 容器与本地单机运行。按团队情况选择，数据迁移成本低。

### 方式一：本地部署（单机 / 单店自用）

即上节“本地运行”。数据在 `instance/shiftlite.db`，备份 = 复制该文件（或在“设置”页一键下载）。
适合门店一台收银/办公电脑本机使用，不对外暴露网络，安全面最小。

### 方式二：Cloudflare Workers 部署（推荐，全球边缘网络）

`cloudflare/` 目录包含本工具的 **Cloudflare Workers 版本**：同一套业务规则与界面，
以 JavaScript 重写运行在 Workers 上，数据存于 D1（SQLite 兼容），静态资源由 Workers 直接伺服。
排班入库校验、冲突规则、周工时/每日人数、停用员工历史展示与复制上周流程均与 Python 版保持一致。
免费额度即可长期运行，无需管理服务器，天然具备 HTTPS 与全球 CDN。

> 两套实现的对齐由自动化测试守护：`core.js` 与 Python 版 `scheduling.py/worktime.py`
> 通过 30 个场景的对齐测试逐字比对（冲突文案、工时汇总、小时舍入平局），见 `npm test`。

**1. 初始化项目**

```bash
cd cloudflare
npm install            # 可选：仅开发/测试需要（wrangler 亦可全局安装）
npx wrangler login
npx wrangler d1 create shiftlite
# 把输出的 database_id 填入 wrangler.toml 的 [[d1_databases]]
```

**2. 建库（含表结构与默认设置）并部署**

```bash
npx wrangler d1 execute shiftlite --remote --file=./migrations/0001_schema.sql
npx wrangler deploy
# 输出形如 https://shiftlite.<你的子域>.workers.dev，浏览器打开即用
```

**3. 载入演示数据（可选）**：部署后调用一次重置接口

```bash
curl -X POST https://shiftlite.<你的子域>.workers.dev/api/reset-demo
```

**4. 本地开发与测试**

```bash
npm run init-db:local        # 本地 D1 建库
npm run dev                  # 本地 Workers 运行时（wrangler dev）
npm test                     # 业务核心对齐测试 + 端到端冒烟测试（node --test test/）
```

**5. 数据管理与自定义域名**

```bash
npx wrangler d1 export shiftlite --remote --output=backup.sql   # 备份
npx wrangler d1 execute shiftlite --remote --file=backup.sql    # 恢复
# 自定义域名：Cloudflare 控制台 → Workers → 域名与路由 → 绑定自有域名（自动 HTTPS）
```

**6. 与 Python 版的差异**（均为有意取舍，不影响业务口径）

| 项 | Python 版 | Workers 版 |
| --- | --- | --- |
| 品牌头像 | 文件上传（≤2MB） | Data URL 存 D1（≤200KB） |
| 数据备份 | 下载 SQLite 文件 | 下载 JSON 全量导出（/backup）；迁移用 `wrangler d1 export` |
| 页面渲染 | Jinja2 服务端渲染 | Worker 内等价服务端渲染（同 CSS/JS、同页面结构） |
| Excel 导出 | openpyxl（含冻结窗格等样式） | 内置轻量 OOXML 生成器（表头/合计行样式） |

**关于 Pages**：本项目静态资源（CSS/JS）已由 Workers 静态资产直出，无需单独的 Pages 站点；
若团队更熟悉 Pages 形态，可将同一前端资产置于 Pages、API 迁移至 Pages Functions，结构同构。
首次公网使用前请阅读下方安全提示（原型未含账号体系）。

### 方式三：Python 云服务器部署（waitress + Nginx）

Python 版是本项目的**主实现与默认部署形态**。适用于购买了一台云主机
（阿里云/腾讯云/轻量服务器等，1核1G 即可）并希望完全自主掌控数据与进程的场景。

**1. 上传代码并安装依赖（以 Ubuntu 为例）**

```bash
sudo apt update && sudo apt install -y python3-venv nginx
git clone <你的仓库地址> /opt/shiftlite && cd /opt/shiftlite
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt waitress
python seed.py                    # 可选：写入演示数据（正式使用可跳过）
```

**2. 用 waitress 启动生产服务（开发服务器仅适合本机试用）**

```bash
SHIFTLITE_SECRET="$(openssl rand -hex 32)" SHIFTLITE_DB=/opt/shiftlite/instance/shiftlite.db   waitress-serve --host=127.0.0.1 --port=5001 --threads=4 app:app
```

**3. 注册为 systemd 服务（开机自启）** `/etc/systemd/system/shiftlite.service`：

```ini
[Unit]
Description=ShiftLite scheduling service
After=network.target

[Service]
WorkingDirectory=/opt/shiftlite
Environment=SHIFTLITE_SECRET=替换为openssl生成的随机串
Environment=SHIFTLITE_DB=/opt/shiftlite/instance/shiftlite.db
ExecStart=/opt/shiftlite/.venv/bin/waitress-serve --host=127.0.0.1 --port=5001 --threads=4 app:app
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now shiftlite
```

**4. Nginx 反向代理 + 域名 HTTPS** `/etc/nginx/sites-available/shiftlite`：

```nginx
server {
    listen 80;
    server_name paiban.example.com;      # 换成你的域名
    client_max_body_size 4m;             # 品牌头像上传上限 2MB，留余量

    location / {
        proxy_pass http://127.0.0.1:5001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/shiftlite /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx   # 一键 HTTPS
```

**5. 数据持久化**：定期备份 `/opt/shiftlite/instance/shiftlite.db`
（`sqlite3 shiftlite.db ".backup backup.db"` 或直接复制文件；云主机可加 crontab 每日备份到对象存储）。

> ⚠️ **公网使用提示**：系统已内置管理员密码登录（会话 7 天）。默认密码 `shiftlite123`
> **部署后必须立即修改**；如需更高安全等级，仍建议叠加 Nginx 基础认证或仅内网/VPN 访问。
> 多用户与分角色权限为后续计划（见报告“总结与展望”）。

### 方式四：Docker / 自管服务器（可选）

项目根目录自带 `Dockerfile`：

```bash
docker build -t shiftlite .

docker run -d --name shiftlite \
  -p 5001:5001 \
  -v shiftlite-data:/data \
  -v shiftlite-uploads:/app/static/uploads \
  -e SHIFTLITE_SECRET="$(openssl rand -hex 32)" \
  shiftlite

# 可选：写入演示数据
docker exec shiftlite python seed.py
```

- `/data` 卷保存 SQLite 数据库，`/app/static/uploads` 卷保存品牌头像——升级镜像不丢数据；
- 云端拉取镜像后在同一台主机 `docker build` 即可；数据迁移 = 备份两个卷；
- 前置 Nginx/Caddy 做 HTTPS 的方式同方式二第 4 步。

### 方式五：PaaS 平台（Render / Railway 等）

Flask 应用可直接部署：启动命令 `pip install -r requirements.txt waitress && waitress-serve --host=0.0.0.0 --port=$PORT app:app`。
**注意**：多数 PaaS 容器文件系统是临时的，重新部署会清空 SQLite 数据——必须挂载平台提供的持久磁盘并把
`SHIFTLITE_DB` 指向磁盘路径，否则仅适合纯演示。数据可靠性要求高的场景建议方式二或三。

### 部署相关环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `SHIFTLITE_DB` | SQLite 数据库文件路径（可指向挂载卷） | `<项目>/instance/shiftlite.db` |
| `SHIFTLITE_SECRET` | Flask 会话密钥（生产必设随机值） | 固定演示值 |

---

## 品牌与图标体系 v1

本项目的界面图标为**依据站点元素原创设计**的线性图标集（22 枚，24×24，stroke 2 圆角端点），
不依赖第三方图标库，以内联 SVG 跟随 `currentColor`，自动适配主题与状态色。

**设计语言（元素取自站点本体）：**

- **日历与班次块**：导航“排班”与品牌图标使用日历轮廓 + 实心/描边圆角小块——实心圆角小块是贯穿全站的“班次/数据”语义（与排班网格中的班次芯片同形）；
- **圆角瓦片**：导航“概览”为四块圆角瓦片，其中一块实心表示“当前所在”；
- **预设条**：导航“班次模板”为公文包内嵌一条实心班次条，表达“可复用的预设内容”；
- **滑杆**：设置页用双滑杆表达“规则可配置”；
- **米色圆角几何**：品牌站点图标（favicon）为主色圆角方 + 米白日历 + 主色容器色班次块，与界面 Material 3 米 beige 主题同源。

**文件与用法：**

| 内容 | 位置 |
| --- | --- |
| 站点图标（favicon / 收藏夹 / 标签页） | `static/icons/favicon.svg`（Workers 版在 `cloudflare/public/static/icons/`） |
| 图标定义（Python 版 Jinja 宏） | `templates/_macros.html` 的 `icon('名称')` |
| 图标定义（Workers 版） | `cloudflare/src/worker.js` 的 `ICONS` 映射（与宏共用同一套路径） |
| 图标总览图 | `docs/screenshots/10-icons.png`（设计源文件 `docs/src/icons-preview.html`） |

用户在“设置”页上传的品牌头像会覆盖默认站点图标；未上传时使用 `favicon.svg`。
新增图标时请同时在 `_macros.html` 与 `worker.js` 中登记同名路径（两版共用一套视觉）。

## 项目结构

```
shiftlite/
├── app.py               # Flask 路由、JSON API、导出/备份/品牌端点
├── db.py / schema.sql   # SQLite 连接、DDL、规则配置
├── seed.py              # 演示数据（含刻意埋设的冲突用于演示检测）
├── core/                # 核心业务（纯函数，不依赖 Flask，便于测试）
│   ├── scheduling.py    #   时间区间、有效工时、五类冲突检测
│   ├── worktime.py      #   工时汇总
│   └── exporter.py      #   Excel 生成
├── templates/ static/   # Jinja2 页面 + Material 3 米 beige 主题 + 原生 JS
├── tests/               # pytest 测试套件
├── scripts/benchmark.py # 性能计时脚本
├── Dockerfile           # 自管容器部署（waitress 生产服务器 + 数据卷）
├── cloudflare/          # Cloudflare Workers 版（业务核心 JS 对齐移植 + D1 + 测试）
└── docs/                # 技术研究报告、截图、性能结果
```

## 演示数据说明

`seed.py` 写入示例门店“青禾轻食·大学城店”：10 名员工、4 个班次模板、当前周与下周共 66 条排班（当前周 47 条），
并在当前周刻意安排了**重叠、不可排班日、班间休息不足、日/周工时超限**等场景，
打开“排班”页即可在冲突面板看到检出结果。数据均为虚构演示数据。

## 当前边界（重要）

- 已内置**单管理员密码登录**（限速 + 改密），员工自助账号与分角色权限为后续计划；公网部署请阅读“方式三”安全提示；
- 员工移动端自助查看、考勤打卡、薪资计算、自动排班**均未实现**，见报告“总结与展望”；
- 工时上限等规则默认值仅作演示口径，**正式使用前须按当地法规与机构适用规定确认具体设置**；
- 全部数据存于本地 SQLite 文件，备份 = 下载该文件副本（或备份 Docker 卷）。

## 交付物

| 交付物 | 位置 |
| --- | --- |
| 技术研究报告（PDF，31 页） | `docs/技术研究报告.pdf`（HTML 源在 `docs/src/`） |
| 可运行原型与全部源代码 | 本目录 |
| 运行截图（9 张） | `docs/screenshots/` |
| 性能测量结果 | `docs/perf-results.md` |
| 演示视频脚本 | `docs/演示脚本.md` |
| 数据库结构（DDL） | `schema.sql`（报告附录 A） |
| Cloudflare Workers 云端版 | `cloudflare/`（含对齐测试与端到端测试） |
| 原创图标体系（22 枚 + favicon） | `static/icons/`、`templates/_macros.html`；总览图 `docs/screenshots/10-icons.png` |
