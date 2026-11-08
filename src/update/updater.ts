/**
 * 自动更新：启动时去 GitHub Releases 看有没有新版本（latest.json），
 * 有就下载、校验签名（Tauri 更新密钥）、替换 app，再重启。
 *
 * 测试模式（?test&update）不联网，给一个假的新版本，用来测界面：
 *   ?update        有新版本，下载顺利
 *   ?update=fail   下载到一半失败
 */
import pkg from "../../package.json";

export interface UpdateInfo {
  version: string;
  notes: string;
  /** 下载并安装；进度 0–1，不知道总大小时给 null */
  install(onProgress: (p: number | null) => void): Promise<void>;
}

const isTest = () => (window as unknown as { __BANZOU_TEST__?: boolean }).__BANZOU_TEST__ === true;

/** 正在运行的版本（正式 app 以打包时的版本为准） */
export async function currentVersion(): Promise<string> {
  if (isTest()) return pkg.version;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (isTest()) return fakeUpdate();
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body ?? "",
    async install(onProgress) {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          onProgress(total > 0 ? Math.min(1, got / total) : null);
        } else if (e.event === "Finished") onProgress(1);
      });
    },
  };
}

export async function restart() {
  if (isTest()) {
    const url = new URL(location.href);
    url.searchParams.delete("update");
    location.href = url.toString();
    return;
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** 只在正式 app 里启动时自动检查；测试模式要带 ?update */
export function shouldAutoCheck() {
  if (isTest()) return new URLSearchParams(location.search).has("update");
  return !import.meta.env.DEV;
}

/** 更新失败时给人看的话 */
export function describeUpdateError(e: unknown): string {
  const s = String(e);
  if (/signature/i.test(s)) return "下载的更新签名不对，为了安全没有安装。请到 GitHub 手动下载。";
  if (/network|connect|dns|timed? ?out|request|status code|fetch/i.test(s)) return "连不上 GitHub，检查一下网络再试。";
  return `更新失败：${s}`;
}

function fakeUpdate(): UpdateInfo | null {
  const mode = new URLSearchParams(location.search).get("update");
  if (mode === null) return null;
  if (mode === "none") return null;
  return {
    version: "9.9.9",
    notes: "测试用的新版本\n- 修了一个小问题\n- 练声加了一个新练习",
    install: (onProgress) =>
      new Promise((resolve, reject) => {
        let p = 0;
        const id = window.setInterval(() => {
          p += 0.1;
          onProgress(Math.min(1, p));
          if (mode === "fail" && p >= 0.5) {
            window.clearInterval(id);
            reject(new Error("error sending request: connection reset"));
          } else if (p >= 1) {
            window.clearInterval(id);
            resolve();
          }
        }, 150);
      }),
  };
}
