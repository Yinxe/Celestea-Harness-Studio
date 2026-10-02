// @vitest-environment node
/**
 * 桌面打包门禁：这些不变量一旦被破坏，产出的包**照样能编译**，但用户那边是
 * 「窗口空白 / 连不上后端 / 更新永远不生效」——所以必须机械钉住，不能靠人记得。
 *
 * 每条断言都对应一次**实测到的**真实故障，注释里写明是哪一次。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const pkg = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;

/** 五个已核实的目标三元组（deno desktop 自己的 --all-targets 列表）。 */
const TRIPLES = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
  'x86_64-pc-windows-msvc',
];

describe('桌面端入口（scripts/desktop/main.ts）', () => {
  const entry = read('scripts/desktop/main.ts');

  it('静态根必须在 @celestea/studio 被导入之前写好', () => {
    // 实测：顺序反了不会崩，只会静静地给用户端上「build the frontend first」提示页。
    const setAt = entry.indexOf('STUDIO_STATIC_ROOT');
    const importAt = entry.indexOf('await import("@celestea/studio")');
    expect(setAt, '必须显式设置 STUDIO_STATIC_ROOT').toBeGreaterThan(-1);
    expect(importAt, '必须动态导入 @celestea/studio').toBeGreaterThan(-1);
    expect(setAt, '赋值必须早于导入（否则静态根取的是编译产物的虚拟路径）').toBeLessThan(importAt);
  });

  it('端口由系统分配（port: 0），不与 celestea web 抢 3777', () => {
    expect(entry).toContain('port: 0');
  });

  it('关窗要停服务并退出，否则进程会带着不可见的监听器活着', () => {
    expect(entry).toContain('win.onclose');
    expect(entry).toContain('handle.stop');
    expect(entry).toContain('Deno.exit(0)');
  });

  it('Deno.autoUpdate 必须存在性守卫', () => {
    // 实测：Deno 2.9.7 只在桌面运行时注入 autoUpdate/desktopVersion，
    // `deno run` 下它们是 undefined —— 不守卫就是 TypeError。
    expect(entry).toContain('typeof Deno.autoUpdate !== "function"');
    expect(entry).toContain('CELESTEA_DESKTOP_UPDATE_URL');
  });
});

describe('桌面构建脚本（scripts/desktop-build.mjs）', () => {
  const build = read('scripts/desktop/build.mjs');

  it('覆盖全部五个目标三元组', () => {
    for (const triple of TRIPLES) expect(build, '缺少 ' + triple).toContain(triple);
  });

  it('内嵌冻结契约数据', () => {
    // 实测：精简包不含 packages/core/contracts 时，verifyContractsAtStartup 抛
    // "repository root not found" —— 入口在创建窗口前就死了（表现是「没有 UI」）。
    expect(build).toContain('packages');
    expect(build).toContain('contracts');
  });

  it('import map 用绝对 file:// 地址', () => {
    // 实测：相对映射在 `--hmr` 下按 cwd 解析，后端直接 Module not found（只有 dev 复现）。
    expect(build).toContain('pathToFileURL');
  });

  it('--env-file 带等号', () => {
    // 实测：写成 `--env-file <path>` 时值不被消费，路径会被当成入口文件，
    // 报错是 "envfile is not defined"（与 env 文件毫无关系，极易误诊）。
    expect(build).toContain('"--env-file=" +');
  });

  it('deb/rpm 用发行版惯例的包名', () => {
    // 实测：包名取自输出文件名，带三元组时会装成
    // `celesteastudio-x86-64-unknown-linux-gnu` 这种没人认识的包。
    expect(build).toContain('celestea-studio-');
    expect(build).toContain('amd64');
    expect(build).toContain('arm64');
  });

  it('调用方传的 --output/--target 不得重复透传', () => {
    // 实测：`deno desktop` 取同名参数的**最后一次**出现，于是「我们的绝对路径 +
    // 调用方的相对路径」让产物落进 scripts/desktop/scripts/desktop/dist/…
    // 而 wrapper 还照样打印它以为的路径。
    expect(build).toContain('stripFlag');
    expect(build).toContain('stripFlag(forwarded, ["--output", "-o", "--target"])');
  });

  it('每一轮都必须把 --target 传给 deno desktop', () => {
    // 实测：漏传时 deno 编的是**主机**二进制，而输出名已按目标三元组命名 ——
    // 表现就是「--all-targets 产出全平台」，其实每一个都是同一个平台。
    expect(build).toContain('args.push("--target", triple)');
  });

  it('dev 直接跑 TS 源码，不跑 tsc/vite', () => {
    // 之前每次 desktop:dev 都跑一遍 pnpm build（8 个包 tsc + vite）——实测这让
    // 启动从 ~4 秒变成 40 秒以上，是开发中最贵的一步。
    expect(build).toContain('src/index.ts');
    expect(build).toContain('dev mode: TypeScript sources');
    expect(build).toContain('if (mode === "build") {');
  });

  it('dev 监听源码并自动重启（Deno 只监听入口目录，靠不住）', () => {
    expect(build).toContain('function startDev');
    expect(build).toContain('— restarting');
    expect(build).toContain('starting the app');
    expect(build).toContain(' (reload)');
    // 入口目录不能被监听：重启会自触发死循环。
    expect(build).toContain('join(REPO, "packages"), join(REPO, "apps", "studio", "src")');
  });

  it('macOS 的 .app 可交叉编译，.dmg 只在 macOS 主机上做', () => {
    // 实测（Linux 主机）：`--target aarch64-apple-darwin --output <stem>` 产出
    // `<stem>.app/Contents/…`，合法；`.dmg` 走 hdiutil，只能在 macOS 上。
    expect(build).toContain('hostFamily() === "apple"');
    expect(build).toContain('".dmg"');
  });

  it('产物名不带目标三元组的 vendor 段（unknown）', () => {
    // 用户看到 `CelesteaStudio-x86_64-unknown-linux-gnu.AppImage` 里的 unknown
    // 就是三元组的 vendor 段；产物名改用 linux/macos/windows + x64/arm64。
    expect(build).toContain('osArchLabel');
    expect(build, '不得再用完整三元组拼产物名').not.toContain('"CelesteaStudio-" + triple');
  });
});

describe('发布 workflow（.github/workflows/desktop-release.yml）', () => {
  const wf = read('.github/workflows/desktop-release.yml');

  it('只允许手动触发（铁律 9：发布必须有人在场）', () => {
    expect(wf).toContain('workflow_dispatch');
    expect(wf, '不得挂 push 触发').not.toContain('push:');
    expect(wf, '不得挂 pull_request 触发').not.toContain('pull_request');
  });

  it('五个目标各一个矩阵项', () => {
    for (const triple of TRIPLES) expect(wf, '缺少 ' + triple).toContain(triple);
  });

  it('Release 需要写权限，且只在 publish 勾选时执行', () => {
    expect(wf).toContain('contents: write');
    expect(wf).toContain('if: ${{ inputs.publish }}');
  });

  it('补丁用原生 bsdiff（不能换成仓库里 zstd 包装的那个）', () => {
    expect(wf).toContain('bsdiff');
    expect(wf).toContain('scripts/desktop/update.mjs');
  });

  it('手工发布只问一个问题；其余全部派生', () => {
    // 4 个 inputs 是过度设计：版本从 tag 派生、两个"外部来源"旋钮是仓库变量
    // （设一次，不必每次跑时回答），只有"要不要发"必须每次明确。
    const inputsBlock = wf.slice(wf.indexOf('workflow_dispatch:'), wf.indexOf('concurrency:'));
    expect(inputsBlock).toContain('publish');
    for (const gone of ['inputs.version', 'inputs.update_repo', 'inputs.update_base_url']) {
      expect(wf, gone + ' 不该再出现').not.toContain(gone);
    }
    expect(wf).toContain('vars.DESKTOP_UPDATE_BASE_URL');
  });

  it('workflow 里钉死的版本与本仓声明一致（环境自洽）', () => {
    const manifest = JSON.parse(read('package.json')) as {
      engines?: { node?: string };
      packageManager?: string;
    };
    const engines = String(manifest.engines?.node ?? '');
    const lower = Number(/^>=\s*(\d+)/.exec(engines)?.[1]);
    const upper = Number(/<\s*(\d+)/.exec(engines)?.[1]);
    const nodePin = Number(/node-version:\s*(\d+)/.exec(wf)?.[1]);
    expect(engines, 'engines.node 必须能解析成 >=x <y').toBeTruthy();
    expect(nodePin, 'CI 的 node 必须落在 engines 区间内').toBeGreaterThanOrEqual(lower);
    expect(nodePin).toBeLessThan(upper);
    // pnpm 版本必须与 packageManager 字段一致，否则 frozen-lockfile 立马红。
    const pnpmPin = /pnpm\/action-setup@v4[\s\S]*?version:\s*([\d.]+)/.exec(wf)?.[1];
    expect(manifest.packageManager).toBe('pnpm@' + pnpmPin);
    // deno 必须钉到具体版本（experimental 的特性，浮动的 v2.x 会悄悄改变产物），
    // 而且文档里的说法要跟这个钉住的值一致。
    const denoPin = /deno-version:\s*([^\n]+)/.exec(wf)?.[1]?.trim() ?? '';
    expect(denoPin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read('docs/desktop.md')).toContain(denoPin);
  });

  it('workflow 自检构建环境，而不是假设 runner 什么都有', () => {
    // 交叉编译要 Deno 预构建运行时、整理要 zip、补丁要 bsdiff、冒烟要虚拟显示。
    expect(wf).toContain('Preflight');
    for (const tool of ['zip', 'gh', 'xvfb-run', 'curl']) {
      expect(wf, 'preflight 应断言 ' + tool).toContain(tool);
    }
    expect(wf).toContain('command -v bsdiff');
  });

  it('一台 ubuntu 构建全平台（不再需要按平台分 runner）', () => {
    // deno 的交叉编译靠下载各目标预构建运行时，所以 macOS/Windows 也要在这里出。
    expect(wf).toContain('runs-on: ubuntu-latest');
    expect(wf).not.toContain('macos-latest');
    expect(wf).not.toContain('windows-latest');
    expect(wf).toContain('--all-targets');
  });

  it('latest.json 与暂存集在构建 job 里生成，release job 只上传', () => {
    // 构建 job 才有 app 目录（补丁要对它做 diff），所以 feed + 整理都在那里做；
    // release job 拿到的是 flat 的 release/** 产物，只负责上传。
    expect(wf).toContain('--no-release');
    expect(wf).toContain('--previous-release latest');
    expect(wf).toContain('path: scripts/desktop/dist/release/**');
    expect(wf).toContain('--publish-staged artifacts');
  });

  it('只发 GitHub Release；R2 上传是可选且 CI 不启用', () => {
    // 更新源上传需要「直出 200 无跳转」的静态源，Release 资产地址是 302，用不了；
    // 现在的发布链路只建 Release。
    expect(wf).toContain('scripts/desktop/publish.mjs');
    expect(wf, 'workflow 不得注入 R2 凭据').not.toContain('R2_ACCESS_KEY_ID');
    expect(wf, 'workflow 不得直接跑 aws s3').not.toContain('aws s3 sync');
    expect(read('scripts/desktop/publish.mjs'), 'R2 只在显式 --r2 时启用').toContain('argv.includes("--r2")');
  });

  it('绝不走 npm 发布路径', () => {
    for (const forbidden of ['npm publish', 'pnpm publish', 'pnpm -r publish']) {
      expect(wf, '桌面发布不得触碰 npm：' + forbidden).not.toContain(forbidden);
    }
  });

  it('workflow 里没有任何密钥材料（连 R2 凭据都不需要）', () => {
    // 发布只需要 GITHUB_TOKEN；一旦有人把真钥匙贴进 workflow，这两条会立刻变红。
    expect(wf, '只该用内置的 GITHUB_TOKEN').toContain('secrets.GITHUB_TOKEN');
    expect(wf, '不得出现 Cloudflare API 令牌字面量').not.toMatch(/cfut_[A-Za-z0-9]/);
    expect(wf, '不得出现 32 位十六进制访问密钥字面量').not.toMatch(/\b[0-9a-f]{32}\b/);
  });
});

describe('系统托盘（scripts/desktop/tray.ts）', () => {
  const tray = read('scripts/desktop/tray.ts');
  const icon = read('scripts/desktop/tray-icon.ts');
  const entry = read('scripts/desktop/main.ts');

  it('Tray/dock 只在桌面运行时存在，必须守卫', () => {
    // 与 autoUpdate 同理：`deno run` 下 Deno.Tray 是 undefined。
    expect(tray).toContain('typeof Deno.Tray !== "function"');
    // 后端建不了托盘时 trayId === 0，之后所有调用静默 no-op —— 必须显式降级。
    expect(tray).toContain('tray.trayId === 0');
    expect(tray).toContain('active: false');
  });

  it('菜单项都带必填的 enabled，且退出项真的退出', () => {
    expect((tray.match(/enabled: true/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(tray).toContain('hooks.quit()');
  });

  it('图标是内联 PNG 字节（setIcon 要字节，不是路径）', () => {
    expect(icon).toContain('TRAY_ICON_PNG');
    expect(icon).toContain('atob(');
    expect(icon).toContain('Uint8Array.from');
    expect(tray).toContain('setIcon(TRAY_ICON_PNG)');
  });

  it('入口装了托盘，且主窗口保留系统边框（托盘不是唯一入口）', () => {
    expect(entry).toContain('installTray');
    // 主窗口保留边框：只有那个用户看不见的锚点窗口才是 frameless。
    const mainWindow = /new Deno\.BrowserWindow\(\{ title: "Celestea Studio"[^}]*\}/.exec(entry)?.[0] ?? '';
    expect(mainWindow, '主窗口必须保留系统边框').not.toContain('frameless');
    expect(entry).toContain('frameless: true');
  });

  it('关窗不退出应用：常驻隐藏锚点 + 窗口按需重建', () => {
    // 实测（本机，2.9.7）：close 请求不可取消 —— `preventDefault()` 无效，
    // 进程随最后一个窗口一起结束（关窗后服务立刻不再响应）。所以进程必须常驻
    // 一个用户看不见的窗口，"关窗"才不等于"退出"，托盘才活得下来。
    expect(entry).toContain('keep-alive anchor window');
    expect(entry).toContain('function openMain');
    expect(entry).toContain('noActivate: true');
    // 关窗后日志要明说还在跑，并且托盘能重新叫回窗口。
    expect(entry).toContain('still running in the tray');
  });

  it('没有托盘时不隐藏窗口（否则用户找不回它）', () => {
    expect(entry).toContain('tray.active');
    expect(entry).toContain('CELESTEA_DESKTOP_CLOSE');
    // 冒烟钩子走显式退出路径，CI 才不会挂到超时。
    expect(entry).toContain('stop("smoke")');
  });
});

describe('发布命令（scripts/desktop-publish.mjs）', () => {
  const pub = read('scripts/desktop/publish.mjs');

  it('凭据只从环境读，仓库里没有任何密钥字面量', () => {
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      expect(pub, '必须读 ' + name).toContain(name);
    }
    expect(pub).toContain('process.env[');
    expect(pub, '不得出现 Cloudflare API 令牌').not.toMatch(/cfut_[A-Za-z0-9]/);
    expect(pub, '不得出现 32 位十六进制密钥').not.toMatch(/\b[0-9a-f]{32}\b/);
  });

  it('feed 与安装包都传 R2，并建 GitHub Release', () => {
    expect(pub).toContain('"s3"');
    expect(pub).toContain('"sync"');
    expect(pub).toContain('downloads/');
    expect(pub).toContain('"create"');
    expect(pub).toContain('--generate-notes');
  });

  it('有 --dry-run，且不执行任何外部命令', () => {
    expect(pub).toContain('--dry-run');
    expect(pub).toContain('would run');
  });

  it('五个目标的产物标签映射齐全', () => {
    // 产物名用 linux-x64 这类标签，不是三元组；漏一个就会静默跳过整个平台。
    for (const label of ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64']) {
      expect(pub, '缺少标签 ' + label).toContain(label);
    }
  });
});

describe('更新检测（没有静态源时走 GitHub Release）', () => {
  const entry = read('scripts/desktop/main.ts');
  const update = read('scripts/desktop/update-check.ts');
  const build = read('scripts/desktop/build.mjs');
  const wf = read('.github/workflows/desktop-release.yml');

  it('没有静态源时用 GitHub Release 检测，静态源存在时不走这条路', () => {
    // 静态源是唯一能打补丁的路径（Deno.autoUpdate）；没配时退化为「查 Release 比版本」。
    expect(entry).toContain('watchGitHubReleases');
    expect(entry).toContain('fetchLatestRelease');
    expect(entry).toMatch(/updateUrl === ""/);
    expect(entry).toContain('CELESTEA_DESKTOP_UPDATE_REPO');
  });

  it('检测只告知，不偷偷下载安装', () => {
    // Release 资产地址是 302，Deno 的更新器拒绝跳转，所以这条路只报版本 + 给下载链接。
    expect(update).toContain('releases/latest');
    expect(update).not.toContain('autoUpdate');
    // 只给入口：打印 Release 链接 + 托盘菜单项；没有任何下载/写盘/执行动作。
    expect(entry).toContain('download: ');
    expect(entry).toContain('see: ');
    expect(entry).not.toContain('Deno.Command');
    expect(entry).not.toContain('writeFileSync');
  });

  it('更新检测的仓库是显式配置，不猜 origin、不写死任何仓库', () => {
    // fork 是常见情形：从 origin 推导会把 fork 的构建指向 fork 的 Release，
    // 写死名字则会把所有 fork 指向同一项目。所以只认显式配置。
    expect(build).toContain('CELESTEA_DESKTOP_UPDATE_REPO');
    expect(build).not.toContain('originRepo');
    expect(build, '不得调用 git 去猜仓库').not.toContain('execFileSync("git"');
    // CI 自动注入运行本 workflow 的仓库；想跟上游就设仓库变量覆盖。
    expect(wf).toContain('vars.DESKTOP_UPDATE_REPO || github.repository');
  });

  it('优先拉 Release 里的 latest.json，拿不到才退回 Releases API', () => {
    // 一次请求、无匿名限流，还带每平台补丁信息；API 是兜底（老 Release 没这个资产）。
    expect(update).toContain('releases/latest/download/latest.json');
    expect(update).toContain('fetchReleaseManifest');
    expect(update).toContain('api.github.com');
    expect(entry.indexOf('fetchReleaseManifest(updateRepo')).toBeGreaterThan(-1);
    expect(entry.indexOf('fetchReleaseManifest(updateRepo')).toBeLessThan(
      entry.indexOf('fetchLatestRelease(updateRepo'),
    );
    // 清单里能看出「本平台有没有补丁」。
    expect(entry).toContain('patch available for');
  });

  it('清单生成器按产物标签（linux-x64）找 dylib，而不是按三元组', () => {
    // 产物名用标签后，按三元组匹配会一个都找不到——实测它会报
    // "no runtime dylib for x86_64-unknown-linux-gnu"，而文件就在同目录下。
    const gen = read('scripts/desktop/update.mjs');
    expect(gen).toContain('const LABELS');
    for (const label of ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64']) {
      expect(gen, '缺少标签 ' + label).toContain(label);
    }
    expect(gen).toContain('markers.some((marker) => name.includes(marker))');
  });

  it('聚合清单由生成器合并产出，并随暂存目录一起发布', () => {
    // 每目标清单同名 latest.json，作为资产会撞名；所以另出一份带 platforms 的聚合清单。
    const gen = read('scripts/desktop/update.mjs');
    expect(gen).toContain('aggregate manifest');
    expect(gen).toContain('aggregate.platforms[triple]');
    // 原样保留在各目标目录里，同时被暂存步骤收进 release/。
    expect(gen).toContain('aggregatePath');
    expect(read('scripts/desktop/stage.mjs')).toContain('join(feed, "latest.json")');
  });

  it('发布前先把可分发文件整理进 dist/release/', () => {
    const stage = read('scripts/desktop/stage.mjs');
    const pub = read('scripts/desktop/publish.mjs');
    // 目录不能当 Release 资产：macOS .app / Windows 便携目录打成 zip。
    expect(stage).toContain('zipDirectory');
    expect(stage).toContain('ZIP_DIRECTORY');
    // deb/rpm 的名字里没有平台标签，只有发行版架构词，必须单独匹配。
    expect(stage).toContain('ARCH_TOKENS');
    expect(stage).toContain('amd64');
    expect(stage).toContain('aarch64');
    // 校验和与索引，以及"发布必须是暂存目录"。
    expect(stage).toContain('SHA256SUMS');
    expect(stage).toContain('release.json');
    expect(pub).toContain('scripts/desktop/stage.mjs');
    expect(pub).toContain('githubRelease(version, releaseDir)');
  });

  it('只要与当前版本不一致就提示（相同则静默）', () => {
    // 用户口径：latest 里的信息与已安装版本不一致 → 提示。相同 → 不打扰。
    expect(entry).toContain('if (order === "same")');
    expect(entry).toContain('return;');
    // 三种不一致各有文案：更新 / 更旧（明确不是升级）/ 无法比较。
    expect(entry).toContain('newer release available');
    expect(entry).toContain('is OLDER than this build');
    expect(entry).toContain('is not comparable with');
    // 提示一定带下载或查看入口，且更新才改窗口标题。
    expect(entry).toContain('tray.markUpdate(release.tag, release.htmlUrl, "download")');
    expect(entry).toContain('tray.markUpdate(release.tag, release.htmlUrl, "view")');
  });

  it('无法比较的 tag（hash/nightly）只提示查看，不声称“有新版”', () => {
    // 这是刻意的：`abc1234` 或 `nightly` 与 2.8.1 之间没有序关系，说“有新版”是
    // 数据不支持的断言。托盘文案随之分成「下载新版」与「查看发行版」两种。
    expect(update).toContain('"unknown"');
    expect(entry).toContain('is not comparable with');
    expect(entry).toContain('"view"');
    expect(read('scripts/desktop/tray.ts')).toContain('查看发行版');
  });

  it('清单生成器拒绝构造降级补丁（运行时不排序，只做字符串相等）', () => {
    // Deno 的运行时判断是 `manifest.version === Deno.desktopVersion`，没有序关系；
    // 所以一份指回旧版本的清单**会**被当成更新应用。必须在生成端拦住。
    const gen = read('scripts/desktop/update.mjs');
    expect(gen).toContain('function releaseOrder');
    expect(gen).toContain('refusing to patch');
    expect(gen).toContain('releaseOrder(version, previous.version)');
  });

  it('版本比较按段比较并忽略 v 前缀', () => {
    // 纯规则写在这里，避免为一个 10 行函数跑网络。
    const newer = (a: string, b: string): boolean => {
      const l = a.replace(/^v/i, '').split('.');
      const r = b.replace(/^v/i, '').split('.');
      for (let i = 0; i < Math.max(l.length, r.length); i++) {
        const x = Number.parseInt(l[i] ?? '0', 10);
        const y = Number.parseInt(r[i] ?? '0', 10);
        if (Number.isNaN(x) || Number.isNaN(y)) return a !== b;
        if (x !== y) return x > y;
      }
      return false;
    };
    expect(newer('v2.9.0', '2.8.1')).toBe(true);
    expect(newer('2.8.1', '2.8.1')).toBe(false);
    expect(newer('2.8.0', '2.8.1')).toBe(false);
    expect(newer('v2.10.0', '2.9.9')).toBe(true);
    // 与实现保持一致：源码里的规则必须真按段比较，而不是字符串比较。
    expect(update).toContain('function compareRelease');
    expect(update).toContain('Number.parseInt(a[i] ?? "0", 10)');
    expect(update).toContain('return x > y ? "newer" : "older"');
  });
});

describe('引用一致性（防止改名后留下死引用）', () => {
  it('workflow/文档/脚本里提到的每个 scripts 文件都真实存在', () => {
    // 这一条是被真实的漂移打出来的：脚本搬进 scripts/desktop/ 之后，注释、文档与
    // 测试里还留着旧名字，而 workflow 已经指向新路径 —— 两边各自都"看着没问题"。
    const sources = [
      '.github/workflows/desktop-release.yml',
      'docs/desktop.md',
      'README.md',
      'package.json',
      'scripts/desktop/build.mjs',
      'scripts/desktop/stage.mjs',
      'scripts/desktop/update.mjs',
      'scripts/desktop/publish.mjs',
      'scripts/desktop/main.ts',
    ];
    const missing: string[] = [];
    for (const source of sources) {
      const text = read(source);
      for (const match of text.matchAll(/scripts\/[A-Za-z0-9_./-]+\.(?:mjs|ts|d\.ts)/g)) {
        const ref = match[0];
        if (ref.includes('dist/') || ref.includes('<')) continue; // 构建产物/占位符
        if (!existsSync(join(ROOT, ref))) missing.push(source + ' -> ' + ref);
      }
    }
    expect(missing, '这些引用指向不存在的文件：').toEqual([]);
  });
});

describe('命令与忽略规则', () => {
  it('package.json 暴露 dev/inspect/build/build:all/publish', () => {
    const scripts = (pkg('package.json').scripts ?? {}) as Record<string, string>;
    for (const name of ['desktop:dev', 'desktop:inspect', 'desktop:build', 'desktop:build:all', 'desktop:publish']) {
      expect(scripts[name], '缺少脚本 ' + name).toBeDefined();
    }
  });

  it('构建产物与生成文件都在 git 盲区', () => {
    const ignore = read('.gitignore');
    expect(ignore).toContain('scripts/desktop/webdist/');
    expect(ignore).toContain('scripts/desktop/vendor/');
    expect(ignore).toContain('scripts/desktop/deno.json');
    expect(existsSync(join(ROOT, 'scripts/desktop/main.ts'))).toBe(true);
  });
});
