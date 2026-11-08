// 打包一个新版本，准备好上传到 GitHub Releases 的文件。
//
// 用法：
//   1. 改版本号：package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml 三处一致
//   2. 在 CHANGELOG.md 最上面写这个版本的「## x.y.z」和改动（会显示在用户的更新提示里）
//   3. node scripts/release.mjs             打包到 release/<版本>/
//      node scripts/release.mjs --publish   打包并发布到 GitHub（需要 gh 已登录）
//      加 --no-build：不重新打包，直接用上次打好的（比如本地测过自动更新的那一份）
//
// 更新签名密钥默认读 ~/.tauri/banzou.key（也可以用环境变量 TAURI_SIGNING_PRIVATE_KEY）。
// 这把密钥不能进仓库，也不能丢：丢了以后，已安装的用户就收不到自动更新了。
//
// 产物：
//   Banzou-<版本>-macOS-arm64.zip           给人手动下载
//   Banzou-<版本>-macOS-arm64.app.tar.gz    给应用内自动更新下载
//   latest.json                              应用启动时检查的版本信息（带签名）
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "dylantlwu/banzou";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const publish = args.includes("--publish");
const noBuild = args.includes("--no-build");
// 本地测自动更新时把下载地址指到本机：BANZOU_UPDATE_BASE=http://localhost:8765
const base = process.env.BANZOU_UPDATE_BASE;

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: app, stdio: "inherit", ...opts });
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

// ---- 版本号 ----
const conf = JSON.parse(fs.readFileSync(path.join(app, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const pkgVersion = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).version;
const cargoVersion = fs.readFileSync(path.join(app, "src-tauri/Cargo.toml"), "utf8").match(/^version = "(.+)"/m)?.[1];
if (pkgVersion !== version || cargoVersion !== version) fail(`三处版本号不一致：tauri.conf.json ${version}，package.json ${pkgVersion}，Cargo.toml ${cargoVersion}`);

// ---- 更新说明 ----
const changelog = fs.readFileSync(path.join(app, "CHANGELOG.md"), "utf8");
const section = changelog.split(/^## /m).find((s) => s.startsWith(version));
if (!section) fail(`CHANGELOG.md 里没有「## ${version}」这一节`);
const notes = section.split("\n").slice(1).join("\n").trim();

// ---- 签名密钥 ----
const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = path.join(os.homedir(), ".tauri/banzou.key");
  if (!fs.existsSync(keyFile)) fail(`找不到更新签名密钥 ${keyFile}`);
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyFile, "utf8").trim();
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

if (publish) {
  try {
    execFileSync("gh", ["release", "view", `v${version}`, "--repo", REPO], { stdio: "ignore" });
    fail(`GitHub 上已经有 v${version} 了，先改版本号`);
  } catch {
    // 没有这个版本，可以发
  }
}

// ---- 打包 ----
if (noBuild) console.log(`用上次打好的包（${version}）…`);
else {
  console.log(`打包伴奏歌词 ${version}…`);
  // 更新包（.app.tar.gz + 签名）只在发版时打；平时自己编译不需要密钥
  run("npm", ["run", "tauri", "build", "--", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } })], { env });
}

const bundle = path.join(app, "src-tauri/target/release/bundle/macos");
const appDir = fs.readdirSync(bundle).find((f) => f.endsWith(".app"));
const tarball = fs.readdirSync(bundle).find((f) => f.endsWith(".app.tar.gz"));
if (!appDir || !tarball || !fs.existsSync(path.join(bundle, `${tarball}.sig`))) fail("没找到打包产物（.app / .app.tar.gz / .sig）");
const built = execFileSync("defaults", ["read", path.join(bundle, appDir, "Contents/Info.plist"), "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
if (built !== version) fail(`打好的包是 ${built}，不是 ${version}，去掉 --no-build 重新打包`);

const out = path.join(app, "release", version);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const name = `Banzou-${version}-macOS-arm64`;
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(bundle, appDir), path.join(out, `${name}.zip`)]);
fs.copyFileSync(path.join(bundle, tarball), path.join(out, `${name}.app.tar.gz`));

const downloadBase = base ?? `https://github.com/${REPO}/releases/download/v${version}`;
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "darwin-aarch64": {
      signature: fs.readFileSync(path.join(bundle, `${tarball}.sig`), "utf8").trim(),
      url: `${downloadBase}/${name}.app.tar.gz`,
    },
  },
};
fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(latest, null, 2) + "\n");

const sha = execFileSync("shasum", ["-a", "256", `${name}.zip`], { cwd: out, encoding: "utf8" }).split(" ")[0];
console.log(`\n✓ ${out}\n  ${name}.zip  SHA-256 ${sha}\n  ${name}.app.tar.gz\n  latest.json`);

// ---- 发布 ----
if (publish) {
  const body = `${notes}\n\n---\n\n下载 \`${name}.zip\`，解压后把「伴奏歌词」拖进「应用程序」。第一次打开的步骤见 [README](https://github.com/${REPO}#安装)。已经装了 0.2.0 或更新版本的，会在应用里收到更新提示。\n\nSHA-256 (${name}.zip): \`${sha}\``;
  const notesFile = path.join(out, "release-notes.md");
  fs.writeFileSync(notesFile, body);
  run("gh", [
    "release", "create", `v${version}`,
    "--repo", REPO,
    "--title", `伴奏歌词 ${version}`,
    "--notes-file", notesFile,
    path.join(out, `${name}.zip`),
    path.join(out, `${name}.app.tar.gz`),
    path.join(out, "latest.json"),
  ]);
  console.log(`\n✓ 已发布 https://github.com/${REPO}/releases/tag/v${version}`);
}
