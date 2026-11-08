import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

async function start() {
  // 浏览器测试模式：只在开发服务器、且地址带 ?test 时启用
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window) && new URLSearchParams(location.search).has("test")) {
    const { installTestBridge, installFakeMic } = await import("./dev/testBridge");
    installTestBridge();
    if (new URLSearchParams(location.search).has("fakemic")) installFakeMic();
  }
  void import("./selftest").then((m) => m.runSelftestIfEnabled());
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
