<p align="center">
  <a href="https://www.waoowaoo.com/">
    <img src="images/cta-banner.png" alt="🚀 探索 AI 影视的下一代创作流 | 立即加入 waoowaoo 在线网页版内测候补" width="800">
  </a>
</p>

<p align="center">
  <img src="public/banner.png" alt="waoowaoo" width="600">
</p>

<h1 align="center">waoowaoo AI 影视 Studio</h1>

<p align="center">
  一款基于 AI 技术的短剧/漫画视频制作工具，支持从小说文本自动生成分镜、角色、场景，并制作成完整视频。
</p>

<p align="center">
  <a href="README_en.md">English</a> · <a href="https://www.waoowaoo.com/">加入内测候补</a> · <a href="https://github.com/saturndec/waoowaoo/issues">反馈问题</a>
</p>

> \[!IMPORTANT]
> ⚠️ **测试版声明**：本项目目前处于测试初期阶段，由于暂时只有我一个人开发，存在部分 bug 和不完善之处。我们正在快速迭代更新中，**欢迎进群反馈问题和需求，及时关注项目更新！目前更新会非常频繁，后续会增加大量新功能以及优化效果，我们的目标是成为行业最强AI工具！**

<img src="https://github.com/user-attachments/assets/d190bf41-488d-47df-a5df-06346ef0f2f5" width="30%">

***

## ✨ 功能特性

- 🎬 **AI 剧本分析** — 自动解析小说，提取角色、场景、剧情
- 🎨 **角色 & 场景生成** — AI 生成一致性人物和场景图片
- 📽️ **分镜视频制作** — 自动生成分镜头并合成视频
- 🎙️ **AI 配音** — 多角色语音合成
- 🌐 **多语言支持** — 中文 / 英文界面，右上角一键切换

***

## 🚀 快速开始

**前提条件**：安装 [Docker Desktop](https://docs.docker.com/get-docker/)

### 方式一：拉取预构建镜像（最简单）

无需克隆仓库，下载即用：

```bash
# 下载 docker-compose.yml
curl -O https://raw.githubusercontent.com/saturndec/waoowaoo/main/docker-compose.yml

# 启动所有服务
docker compose up -d
```

> ⚠️ 当前为测试版，版本间数据库不兼容。升级请先清除旧数据：

```bash
docker compose down -v
docker rmi ghcr.io/saturndec/waoowaoo:latest
curl -O https://raw.githubusercontent.com/saturndec/waoowaoo/main/docker-compose.yml
docker compose up -d
```

> 启动后请**清空浏览器缓存**并重新登录，避免旧版本缓存导致异常。

### 方式二：克隆仓库 + Docker 构建（完全控制）

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo
docker compose up -d
```

更新版本：

```bash
git pull
docker compose down && docker compose up -d --build
```

### 方式三：本地开发模式（开发者）

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo

# 复制环境变量配置文件（必须在 npm install 之前完成）
cp .env.example .env
# ⚠️ 编辑 .env，填入你的 AI API Key（NEXTAUTH_URL 默认已是 http://localhost:3000，无需修改）

npm install

# 只启动基础设施
# 注意：docker-compose.yml 将服务映射到非标准端口，.env.example 已按此预设
mysql:13306  redis:16379  minio:19000
docker compose up mysql redis minio -d

# 初始化数据库表结构（首次必须执行，跳过会导致启动后报错）
npx prisma db push

# 启动开发服务器
npm run dev
```

> \[!WARNING]
> 跳过 `npx prisma db push` 会导致所有数据库表不存在，启动后报错 `The table 'tasks' does not exist`。请务必先运行此命令再启动开发服务器。

***

访问 <http://localhost:13000>（方式一、二）或 <http://localhost:3000>（方式三）开始使用！

> 首次启动会自动完成数据库初始化，无需任何额外配置。

> **部署：** 除非 `NODE_ENV` 正好是 `development` 或 `test`，否则必须设置 `NEXTAUTH_SECRET`（或 `AUTH_SECRET`）。包括未设置和 `staging` 在内的其他取值，在签发或校验资产列表游标时会抛错，接口返回通用的 500，响应里不包含配置细节。

> \[!TIP]
> **如果遇到网页卡顿**：HTTP 模式下浏览器可能限制并发连接。可安装 [Caddy](https://caddyserver.com/docs/install) 启用 HTTPS：
>
> ```bash
> caddy run --config Caddyfile
> ```
>
> 然后访问 <https://localhost:1443>

***

## 🔧 API 配置

### 剪辑与成片导出

灵感视频沿用同一创作入口：能力目录声明支持纯文字生成的 Veo / 移动云 Seedance 模型可以不上传主图，其他模型仍需上传。历史支持复用素材和参数、失败重试、取消、删除及分页。生成结果会探测实际尺寸和时长；不支持的视频文件会明确失败。无图协议已通过隔离测试，实际账号能否调用取决于服务商权限。

本次新增镜头独立模型字段，已有 MySQL 部署升级前运行 `npx prisma migrate deploy --schema prisma/schema.prisma`，再运行 `npx prisma generate` 并重启网页与 Worker。此迁移只新增可空字段，可重复执行，不删除旧数据。新部署可按既有流程初始化数据库。

生成镜头视频后，进入「剪辑」调整顺序与转场，保存并导出 MP4。导出在视频任务队列执行，需同时运行网页服务和 Worker；重新打开剪辑页面可查看当前导出状态。新建时间轴继承项目画幅，并按镜头绑定配音与字幕。修改源素材后，旧剪辑引用可能需要重新整理，导出会拒绝失效或跨项目的媒体引用。

本地首次导出需要浏览器运行环境，可执行 `npx remotion browser ensure`，或通过 `REMOTION_BROWSER_EXECUTABLE` 指定 Chromium。Dockerfile 已配置 Chromium 和中文字体，并按 [Remotion 部署说明](https://www.remotion.dev/docs/docker) 使用 Debian 基础镜像。

删除项目后，媒体文件暂时保留，待回收清单位于 `data/media-retention`。回收前必须确认没有全局资产、其他项目或历史记录引用；当前不会自动执行物理回收。请将 `data` 目录纳入持久化与备份。

剧本和分镜整体重生成前会保存已有剧集快照，工作区「剧集历史版本」可以恢复。快照位于 `data/episode-snapshots`，覆盖剧集正文、片段、分镜、台词及剪辑，不包含项目级角色/场景库。恢复时会备份当前版本，并要求当前项目没有运行中的生成任务。多实例部署需要让网页服务与 Worker 共享同一个 `data` 目录；本功能不替代数据库和媒体备份。

启动后进入**设置中心**配置 AI 服务的 API Key，内置配置教程。

> 💡 **注意**：目前仅推荐使用各服务商官方 API，第三方兼容格式（OpenAI Compatible）尚不完善，后续版本会持续优化。

***

## 📦 技术栈

- **框架**: Next.js 15 + React 19
- **数据库**: MySQL + Prisma ORM
- **队列**: Redis + BullMQ
- **样式**: Tailwind CSS v4
- **认证**: NextAuth.js

***

## 📦 页面功能预览

![4f7b913264f7f26438c12560340e958c67fa833a](https://github.com/user-attachments/assets/fa0e9c57-9ea0-4df3-893e-b76c4c9d304b)
![67509361cbe6809d2496a550de5733b9f99a9702](https://github.com/user-attachments/assets/f2fb6a64-5ba8-4896-a064-be0ded213e42)
![466e13c8fd1fc799d8f588c367ebfa24e1e99bf7](https://github.com/user-attachments/assets/09bbff39-e535-4c67-80a9-69421c3b05ee)
![c067c197c20b0f1de456357c49cdf0b0973c9b31](https://github.com/user-attachments/assets/688e3147-6e95-43b0-b9e7-dd9af40db8a0)

***

## 🤝 参与方式

本项目由核心团队独立维护。欢迎你通过以下方式参与：

- 🐛 提交 [Issue](https://github.com/saturndec/waoowaoo/issues) 反馈 Bug
- 💡 提交 [Issue](https://github.com/saturndec/waoowaoo/issues) 提出功能建议
- 🔧 提交 Pull Request 供参考 — 我们会认真审阅每一个 PR 的思路，但最终由团队自行实现修复，不会直接合并外部 PR

***

**Made with ❤️ by waoowaoo team**

<br />

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=saturndec/waoowaoo\&type=date\&legend=top-left)](https://www.star-history.com/#saturndec/waoowaoo\&type=date\&legend=top-left)

<br />

<br />

\#TODO \
1、限制不能生成字幕\
2、增加/完善场景等图片上传的附件逻辑，使得场景和演出角色对应（@功能）

3、监狱牢房的柱子判断问题（9宫格帧图片识别问题）

启动python应用
python -m uvicorn maas_seedance_api:app --host 0.0.0.0 --port 8000 --reload
