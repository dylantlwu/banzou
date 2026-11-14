import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SizesProvider } from "./layout/split";

async function start() {
  // 浏览器测试模式：只在开发服务器、且地址带 ?test 时启用
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window) && new URLSearchParams(location.search).has("test")) {
    const { installTestBridge, installFakeMic } = await import("./dev/testBridge");
    installTestBridge();
    if (new URLSearchParams(location.search).has("fakemic")) installFakeMic();
  }
  // 录我的测试集（PRD 4.12）：?test&testset，只在测试模式里
  if ("__BANZOU_TEST__" in window && new URLSearchParams(location.search).has("testset")) {
    const { TestSetRecorder } = await import("./testset/TestSetRecorder");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<TestSetRecorder />);
    return;
  }
  void import("./selftest").then((m) => m.runSelftestIfEnabled());
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <SizesProvider>
        <App />
      </SizesProvider>
    </React.StrictMode>,
  );
}

void start();
