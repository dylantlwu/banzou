// Vite 开发服务器插件：把浏览器测试模式的 invoke 转给 src-tauri/examples/devbridge 执行。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export function devBridge(): Plugin {
  return {
    name: "banzou-dev-bridge",
    apply: "serve",
    configureServer(server) {
      const app = server.config.root;
      // 优先用 release 版（音高分析、修音渲染快很多）
      const release = path.join(app, "src-tauri/target/release/examples/devbridge");
      const bin = fs.existsSync(release) ? release : path.join(app, "src-tauri/target/debug/examples/devbridge");
      const lib = path.join(app, ".testlib");
      server.middlewares.use("/__bridge/", (req, res) => {
        const cmd = (req.url ?? "").replace(/^\//, "").split("?")[0];
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const child = spawn(bin, [lib, cmd]);
          let out = "";
          let err = "";
          child.stdout.on("data", (c) => (out += c));
          child.stderr.on("data", (c) => (err += c));
          child.on("error", (e) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ err: `测试桥没启动：${e.message}（先跑 npm run test:ui:setup）` }));
          });
          child.on("close", () => {
            res.setHeader("content-type", "application/json");
            res.end(out || JSON.stringify({ err: err || "测试桥没有输出" }));
          });
          child.stdin.end(body);
        });
      });
    },
  };
}
