# 桌面端（`deno desktop`）

> 状态：当前
> 本文是桌面打包/分发的唯一说明：命令、产物集合、自动更新的烘焙方式与发布流程。
> 实现在 [`scripts/desktop/main.ts`](../scripts/desktop/main.ts)（入口）、
> [`scripts/desktop/build.mjs`](../scripts/desktop/build.mjs)（构建）、
> [`scripts/desktop/update.mjs`](../scripts/desktop/update.mjs)（更新清单/补丁），
> 机械门禁在 [`tests/desktop-packaging.test.ts`](../tests/desktop-packaging.test.ts)。

## 为什么能这么便宜地加一个桌面端

桌面入口是 `startStudioServer` 的**第三个调用者**（另两个是 `celestea web` 与
`apps/studio` 的源码入口），不是第二个服务实现；仓库里没有原生插件（服务端依赖只有
`hono` 与 `@hono/node-server`），前端本来就是静态产物，所以后端源码一行没改。

构建工具只有 **`deno desktop`**：交叉编译靠 Deno 按目标下载它自己的**预构建**运行时
（`denort`）与 webview 后端，本机与本仓都不需要 Rust 工具链，也不需要目标平台的 SDK。
`--target` 的取值沿用 Rust 生态那套 `arch-vendor-os` 三元组写法（例如
`x86_64-unknown-linux-gnu`）——只是**命名约定**，其中 `unknown` 是固定的 vendor 字段，
不代表任何东西缺失；产物文件名一律不用它。

## 命令

所有命令都从仓库根跑（都是 `pnpm` 脚本 → `scripts/` 下的脚本，没有隐藏步骤）：

| 命令 | 做什么 | 产物 / 副作用 |
| --- | --- | --- |
| `pnpm desktop:dev` | 开发运行。**直接跑 TypeScript 源码**（Deno 自己编译，不跑 tsc/vite），启动约 4 秒；监听 `packages/**` 与 `apps/studio/src`，改动即自动重启应用 | 窗口 + 本地服务；产物在 `scripts/desktop/dist/dev/` |
| `pnpm desktop:inspect` | 同上，另开调试器（Deno 运行时与渲染进程 DevTools，默认 `127.0.0.1:9229`） | 同上 |
| `pnpm desktop:build` | 按**本机**目标产出该平台的标准安装包集合 | 见下方产物清单 |
| `pnpm desktop:build:all` | **五个目标各产一套**（一台机器就能全出：Deno 会为每个目标下载它自己的预构建运行时与 webview 后端） | 同上，五个目标 |
| `pnpm desktop:publish` | 生成更新清单（`latest.json` + bsdiff 补丁 + 供下一版做补丁的运行时 dylib），并建 GitHub Release 把它们和安装包一起上传 | GitHub Release；`--dry-run` 只打印计划、不需要任何凭据 |
| `pnpm desktop:build -- --target <triple>` | 只编一个目标（例如 `--target aarch64-apple-darwin`） | 单个产物 |
| `pnpm desktop:build -- --output <path>` | 只产一个产物、路径与格式自己定（扩展名决定格式：`.AppImage`/`.deb`/`.rpm`/`.dmg`/`.msi`/无扩展名=目录/.app） | 单个产物 |

`deno desktop` 自己的参数（`--compress`、`--icon`、`--backend`、`--engine` 等）原样透传，
写在 `--` 之后；脚本自己的开关在 `--` 之前。（`--target` / `--output` 由脚本接管：它会
解析成绝对路径并**只传一次**，因为 `deno desktop` 对重复参数取最后一次出现。）

环境变量（都有默认值，只有发布需要显式给）：

| 变量 | 作用 |
| --- | --- |
| `CELESTEA_SKIP_BUILD=1` | 跳过 `pnpm build`（你已经构建过时用；`desktop:dev` 本来就不构建） |
| `CELESTEA_DESKTOP_OUT=<dir>` | 产物目录，默认 `scripts/desktop/dist` |
| `CELESTEA_DESKTOP_VERSION=<x.y.z>` | 覆盖烘焙进应用的版本，默认取 `scripts/version.mjs`（即 `git describe --tags`） |
| `CELESTEA_DESKTOP_UPDATE_BASE_URL=<https 源>` | 烘焙自动更新源（能打补丁的那条路）；不设则退化为 GitHub Release 检测 |
| `CELESTEA_DESKTOP_UPDATE_REPO=<owner/repo>` | GitHub Release 检测的目标仓库；**不设则不做检测**（不推导、不写死） |
| `CELESTEA_DESKTOP_CLOSE=exit` | 关窗即退出（默认是收进托盘继续跑，见「系统托盘」） |
| `CELESTEA_DESKTOP_SMOKE_MS=<毫秒>` | 到点自动退出——CI 用它做「启动→服务→干净退出」的冒烟 |
| `CELESTEA_DESKTOP_SMOKE_CLOSE_MS=<毫秒>` | 到点发出一次真实关窗请求并报告窗口是否存活/能否重建（验证关窗语义用） |
| `CELESTEA_HOME=<dir>` | 数据根（与应用运行时一致，见 [configuration.md](./configuration.md)） |

### 产物清单（`pnpm desktop:build:all`）

| 文件 | 目标 | 已核对的真实架构 |
| --- | --- | --- |
| `CelesteaStudio-<版本>-linux-x64.AppImage` | `x86_64-unknown-linux-gnu` | 内层运行时 `ELF x86-64` |
| `CelesteaStudio-<版本>-linux-arm64.AppImage` | `aarch64-unknown-linux-gnu` | 内层运行时 `ELF ARM aarch64` |
| `celestea-studio-amd64.deb` | 同上 | `dpkg-deb … Architecture` = `amd64` |
| `celestea-studio-arm64.deb` | 同上 | `Architecture` = `arm64` |
| `celestea-studio-x86_64.rpm` / `-aarch64.rpm` | 同上 | 发行版惯例包名 |
| `CelesteaStudio-<版本>-macos-x64.app` / `-macos-arm64.app` | `*-apple-darwin` | `Contents/MacOS/libruntime.dylib` 为 `Mach-O x86_64` / `Mach-O arm64` |
| `CelesteaStudio-<版本>-windows-x64.msi` | `x86_64-pc-windows-msvc` | 目录内 DLL 为 `PE32+ for MS Windows` |

命名规则：`CelesteaStudio-<版本>-<os>-<arch><扩展名>`，`os` 只用 `linux`/`macos`/`windows`
（**不带** `--target` 三元组里的 vendor 段，那个字面量是 `unknown`，出现在文件名里纯属噪声）；
deb/rpm 用发行版惯例名，版本在包元数据里。唯一需要原生宿主的格式是 macOS `.dmg`（走 `hdiutil`），
所以 CI 不出 `.dmg`；需要就在 macOS 上跑 `pnpm desktop:build -- --output out/CelesteaStudio.dmg`。

### 出问题时看哪一行

入口把关键状态都打进了 stdout，按这几行定位，不用猜：

| 日志行 | 含义 |
| --- | --- |
| `serving http://127.0.0.1:<port>/` | 后端起来了。桌面版端口由系统分配，跟你另跑的 `celestea web` **不是一个实例** |
| `static root: …/webdist` | 前端产物的内嵌位置；若窗口显示「build the frontend first」提示页，就是这里没内嵌 |
| `tray active` / `tray unavailable` | 托盘是否可用；不可用时会自动改成「关窗即退出」并保持窗口边框 |
| `close button -> hide to tray` / `quit` | 关窗行为（前者=收进托盘继续跑） |
| `keep-alive anchor window created (hidden)` | 常驻锚点已建（关窗不退出靠它） |
| `window on <url> but /api/workspaces -> HTTP 401` | **界面连不上后端**的典型形态：鉴权 cookie 没落地；下一行会自愈 |
| `window ready on <url> (/api/workspaces HTTP 200)` | 窗口与后端联通（含鉴权）已确认 |
| `version <x.y.z> — no update feed in this build` | 版本已烘焙；本构建不带静态源 → 走 GitHub Release 检测 |
| `newer release available: vX (this build is Y)` | GitHub 上有更新版；下一行是下载链接，托盘菜单会多一项「下载新版」 |
| `up to date (Y; latest release vX)` / `no GitHub release to compare against yet` | 已是最新 / 仓库还没有 Release |

## 三个必须知道的构建事实

1. **静态根必须在导入 `@celestea/studio` 之前写好。** 编译产物的模块路径是虚拟的，
   项目默认的静态根推导会失败——失败方式不报错，只是给用户端上「build the frontend
   first」的提示页。入口因此先设 `STUDIO_STATIC_ROOT`，再动态导入。
2. **冻结契约是数据，必须内嵌。** `packages/core/src/repo.ts` 从自身模块位置往上找
   `<pkg>/contracts`；精简包不含它时，启动第一步的 `verifyContractsAtStartup` 直接抛
   `repository root not found`（表现为窗口起不来）。
3. **端口由系统分配。** 桌面版读 `handle.listening` 拿真实端口，因此它**不是**你另外
   跑着的 `celestea web`——两者数据根相同但服务实例不同，浏览器里打开的旧标签页连的是
   另一个后端。
4. **入口自己的相对导入要用 `.js` 说明符 + `--sloppy-imports`。** `tsc`（NodeNext）要求
   这样写，而 Deno 要求真实扩展名；缺了它连 `tray.ts` 都解析不到（报 `Module not found
   "…/tray.js"`）。
5. **启动时要自检，并准备接受运行时"抢"导航。** 桌面运行时自己会导航那个隐含启动窗口
   （目标是它发布的 `DENO_SERVE_ADDRESS`，那是 `Deno.serve` 应用的契约）；本应用用
   `node:http`，那个端口没人监听，而且这次导航可能落在我们的导航**之后**。后果很具体：
   它会用一次普通的 `GET /` 覆盖掉带 token 的引导页，于是登录 cookie 从未落地，之后每个
   `/api/*` 都 401——**服务明明健康，界面却说连不上后端**（实测：不带 cookie 401、
   带 cookie 200）。入口因此会检查窗口 URL，并从 webview 内部请求一个**受保护**端点
   （`/api/workspaces`，不能是免鉴权的 `/api/health`），401 时重跑引导页。日志里能看到
   `window ready on … (/api/workspaces HTTP 200)`。

## 系统托盘

`Deno.Tray` 由桌面运行时注入（和 `autoUpdate` 一样，`deno run` 下不存在），实现在
[`scripts/desktop/tray.ts`](../scripts/desktop/tray.ts)：显示主窗口、隐藏窗口、在浏览器中打开、退出；
双击图标也会把窗口叫回来。图标是**内联的 base64 PNG**
（[`tray-icon.ts`](../scripts/desktop/tray-icon.ts)）——`setIcon` 要的是 PNG 字节，内联可以
免掉文件路径、`--include` 与读取权限三件事。托盘文案是原生 UI，不进前端 zh/en 字典。

### 关窗 ≠ 退出（这是托盘应用的定义）

**实测的运行时限制**：2.9.7 里窗口关闭请求**不可取消**——在 `onclose` 里调 `preventDefault()`
无效（实测：关窗瞬间 HTTP 服务立刻不再响应，进程随最后一个窗口一起结束）。因此本入口的做法是：

- 进程常驻一个**隐藏的 1×1 锚点窗口**（`frameless` + `noActivate`，用户看不见也点不到），
  让"没有窗口了"这个结束条件永不成立——托盘、HTTP 服务、正在跑的 worker 因此都活着；
- 可见窗口变成**按需资源**：`openMain()` 在窗口已被销毁时重新创建一个并导航到同一个地址，
  托盘菜单的「显示主窗口」走的就是它（实测：`closed=true` 之后 `reopen ok, visible=true`）；
- 关窗后日志会明说：`window closed — still running in the tray`。

两个安全降级：后端建不了托盘时（部分极简 Linux 桌面没有 StatusNotifier 宿主，
`trayId === 0`）**不隐藏也不建锚点**，关窗即退出——否则用户会留下一个找不回来的隐形进程；
`CELESTEA_DESKTOP_CLOSE=exit` 可显式恢复「关窗即退出」。

CI 冒烟用 `CELESTEA_DESKTOP_SMOKE_MS=<毫秒>`（到点走显式退出路径，job 才会结束）；
`CELESTEA_DESKTOP_SMOKE_CLOSE_MS=<毫秒>` 会发出一次真实的关窗请求并报告窗口是否存活、
能否重建——这是唯一能在无人点击标题栏时验证关窗语义的手段。

## 自动更新

有两条路，按是否配了静态源二选一：

### 1) 配了静态源：`Deno.autoUpdate()`（能真正换入新版本）

构建时设 `CELESTEA_DESKTOP_UPDATE_BASE_URL=<https 源>`，构建脚本会把 `version`（来自
`git describe --tags`）与「源 + 目标三元组」一起烘进产物，应用启动后按小时轮询
`<源>/<triple>/latest.json`，把 bsdiff 补丁**暂存**下来，下次启动由启动器换入，
启动失败会自动回滚。清单与补丁由 [`scripts/desktop/update.mjs`](../scripts/desktop/update.mjs)
生成：补丁是对**运行时 dylib** 的 `bsdiff`（Linux 是应用目录里的 `.so`，macOS 是
`Contents/MacOS/libruntime.dylib`，Windows 是应用目录里的 `.dll`），必须用原生 `bsdiff`
——仓库里那个 zstd 包装的 helper 是给 `deno upgrade` 用的，桌面更新器不认。

要求：源必须 **https 且不跳转**（更新器用 `redirect: "error"`，所以 GitHub Release 的 302
资产地址不可用）；打补丁要求安装目录**可写**，因此 root 安装的 `.deb`/`.rpm` 走包管理器升级、
只读挂载的 AppImage 也不行（macOS 的 `.app` 可以）。上游限制：Windows 只下载暂存、不会换入。

### 2) 没配静态源：查 GitHub Release 比版本（只告知，不偷偷装）

没配源时应用退化为**检测**，取数顺序是：

1. **优先拉 Release 资产里的 `latest.json`**（`releases/latest/download/latest.json`）——就是发布命令
   上传的那份**聚合清单**：一次请求、不受匿名 API 限流，还带每平台的补丁表，所以应用能区分
   「有新版且本平台有补丁」与「只能手动下载」；
2. 拿不到（老 Release 没有这个资产 / 还没发过 Release）才退回
   `https://api.github.com/repos/<owner>/<repo>/releases/latest`，只读 `tag_name` 与 `html_url`。

拿到版本后**只要与当前安装的版本不一致就提示**（相同则完全静默）；文案按比较结果分三种：
更新（「下载新版」+ 改窗口标题）、更旧（明说不是升级）、无法比较（「查看发行版」）。

两份都只包含 tag/版本信息，**没有 hash 校验**——检测路径不下载任何东西。取到版本后按段比较
（忽略 `v` 前缀）。有新版时它会：

- 在日志里打印 `newer release available: vX (this build is Y)` 与下载链接；
- 把窗口标题改成 `Celestea Studio <当前版本> — 有新版 <tag>`；
- 在托盘菜单里加一项「下载新版 <tag>」，点它打开 Release 页面（版本**无法比较**时文案变成
  「查看发行版 <tag>」，见下）。

聚合清单长这样（每个目标一个条目，由 [`scripts/desktop/update.mjs`](../scripts/desktop/update.mjs) 逐目标合并写出）：

```json
{
  "version": "2.8.2",
  "platforms": {
    "x86_64-unknown-linux-gnu": {
      "manifest": "x86_64-unknown-linux-gnu/latest.json",
      "patches": { "2.8.1": { "name": "…/patch-2.8.1-to-2.8.2.bin", "sha256": "…" } }
    }
  }
}
```

`<owner>/<repo>` **只能显式给**：构建时设 `CELESTEA_DESKTOP_UPDATE_REPO=<owner/repo>`，它会写进
内嵌 env；没设就完全不做 Release 检测（日志一行 `no CELESTEA_DESKTOP_UPDATE_REPO — Release-based
update checks stay off`）。脚本**不**从 `git remote` 推导、也不写死任何仓库名——fork 是常态：
推导会把 fork 的构建指向 fork 自己的 Release，写死则会把所有 fork 指向同一个项目，两种都是错的。
workflow 里对应一个显式输入 `update_repo`（留空 = 运行该 workflow 的仓库，即 `github.repository`；
fork 想跟随上游就填上游）。仓库还没有 Release 时不会刷屏，只打印一行
`no GitHub release to compare against yet`。

这条路刻意**不下载、不安装**：Release 资产地址是 302，Deno 的更新器拒绝跳转，所以能做的
最诚实的事就是把版本与下载入口告诉用户。想要「自动换入」就得回到第 1 条（静态源）。

### 非标准版本号怎么办

发布不总是 `v2.9.0` 这种写法，两条路的态度不同，且都是刻意选的：

| 发布形态 | GitHub 检测（第 2 条路） | 静态源（第 1 条路） |
| --- | --- | --- |
| 正常 tag（`v2.9.0`） | 按段比数字（`2.10.0 > 2.9.9`，不是字符串比较）；更新则菜单项是「下载新版」 | 清单 `version` 必须**精确相等**才认识当前版本 |
| 带后缀（`v2.9.0-rc1`） | 按数字头读成 `2.9.0`：所以 `2.8.1-rc1` 与 `2.8.1` 视为相同，不会反复提示 | 同上；后缀不同就是不同版本，需要对应的 `patches` 条目 |
| 乱写/hash/branch 名（`nightly`、`abc1234`） | 与当前版本**不一致就提示**，但判定为**无法比较**：打印「not comparable with 2.8.1」+ 链接，菜单项是「查看发行版」，**不声称有新版** | 拿不到对应 `patches` 条目就什么都不做，日志说 `no patch available for X` |
| latest 比当前**更旧**（误发/回退） | 同样提示（不一致），文案明说「is OLDER than this build — not an upgrade」，入口仍是「查看发行版」 | 生成端拒绝构造降级补丁（见下），客户端照旧留在原版本 |
| 没有 Release / 全是 draft 或 prerelease | `releases/latest` 天然跳过 draft 与 prerelease；没有就是 `no GitHub release to compare against yet` | — |
| 只发安装包、不发运行时 dylib | 不影响（只看 tag） | 没有上一版 dylib 就无法生成补丁：清单照发、`patches` 为空，客户端提示无补丁可用 |

**降级是被拦在生成端的**：运行时对版本**没有序关系**（只做字符串相等），所以一份指回旧版本的
清单**会**被当成更新应用。`scripts/desktop/update.mjs` 因此拒绝构造「新版本号不大于旧版本号」
的补丁（含 hash/nightly 这类无法比较的），日志写 `refusing to patch …`；发布顺序错了只会
少一个补丁，不会让用户被降级。

## 发布流程（手动）

[`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml) 只接受
`workflow_dispatch`，而且**只问一个问题**：`publish`（不勾就是只构建 + 留档 artifact）。
其余全部派生，不必每次回答：

| 值 | 来源 |
| --- | --- |
| 版本号 | `git describe --tags`（先打 tag 再发版，见 `docs/AGENT.md` §4） |
| Release 检测的仓库 | 仓库变量 `DESKTOP_UPDATE_REPO`；未设时用 `github.repository`（fork 想跟随上游就设成上游） |
| 静态更新源根地址 | 仓库变量 `DESKTOP_UPDATE_BASE_URL`；未设则构建不带更新源（应用侧更新休眠） |

工作流开头有一步 **Preflight**：它 `command -v` 断言 `zip` / `gh` / `xvfb-run` / `curl` 存在并打印
`node`/`pnpm`/`deno` 版本，`bsdiff` 安装后也自检一次——把"构建需要什么"变成可执行断言，
而不是等发到一半才发现 runner 少个工具。**一台 `ubuntu-latest` 就构建全部五个目标**
——`deno desktop` 的交叉编译靠下载各目标的**预构建**运行时与 webview 后端，不需要 macOS/Windows
机器、不需要 Rust、也不需要目标平台 SDK，所以工作流里没有 runner 矩阵。代价只是墙钟时间，
工作流因此缓存了 Deno 的下载目录（`~/.cache/deno`）。

构建期需要的东西（都由工作流准备）：Node 24 + pnpm 11.22.0（`--frozen-lockfile`）、
Deno 2.9.7（`denoland/setup-deno@v2`，Deno 本身没有 CI/工作流产品，官方就是这个 action）、
一次 `pnpm build`（产出各包 `dist/` 与 `apps/studio/webdist`，`scripts/desktop/build.mjs`
会复用），以及可访问 `dl.deno.land` 的网络。

链路按"谁能拿到什么"分成两个 job：**build job** 里才有各平台的构建产物与 app 目录（补丁要对
运行时 dylib 做 diff），所以 `latest.json` 的生成与 `dist/release/` 的整理都在那里完成；
**release job** 只把这份整理好的产物上传。

```bash
# build job：生成 feed（含聚合 latest.json）并把可分发文件整理进 dist/release/
node scripts/desktop/publish.mjs --no-release --previous-release latest

# release job：只上传整理好的目录
node scripts/desktop/publish.mjs --publish-staged artifacts
```

本地想发版时直接跑 `pnpm desktop:publish`（等于上面两步合起来）：



```
node scripts/desktop/publish.mjs --artifacts <产物目录> --feed <feed 目录> \
  --version <版本> --previous-release latest --no-r2
```

它依次做三件事：拉上一版的运行时 dylib（没有上一版就生成"只宣告版本、不带补丁"的清单）、
按目标生成清单与补丁、建 GitHub Release 并附上安装包 + feed 文件 + 新一版 dylib
（下一版做补丁要用）。`--dry-run` 不需要任何凭据，只打印计划。

**关于更新源**：默认**不上传**任何静态源，只发 Release。这是刻意的——Deno 的更新器以
`redirect: "error"` 拉取清单，而 GitHub Release 资产地址会 302 跳转，**不能**当 feed 源；
所以只要没接一个「直出 200 无跳转」的静态源（R2 公开域名、Pages、自己的 nginx 都行），
应用侧的自动更新就处在休眠状态（构建时不烘更新源，入口根本不调用 `autoUpdate`）。
等有了静态源：构建时设 `CELESTEA_DESKTOP_UPDATE_BASE_URL=<源>`，上传时给
[`scripts/desktop/publish.mjs`](../scripts/desktop/publish.mjs) 加 `--r2`（那时才需要 `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` / `R2_BUCKET` 四个 Secrets）。

## 已知限制

- `deno desktop` 自身标注 experimental；Deno 版本在 workflow 里是**钉死**的（改版本要显式）。
- 只构建五个已核实的三元组；`aarch64-pc-windows-msvc` 在 2.9.7 里既不在
  `--all-targets` 列表、后端归档也未核实，故意不做。
- 自动更新的**应用补丁**路径尚未在真实 https 源上端到端验证过：清单生成、烘焙、
  轮询与失败降级已实测，补丁下载/换入/回滚仍需一次真实发布来确认。
