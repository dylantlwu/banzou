import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Btn } from "../components/Btn";
import "./net.css";

type Route = "direct" | "system";

/** 后端 net::Service */
interface Service {
  id: string;
  name: string;
  usedFor: string;
  url: string;
  route: Route;
  defaultRoute: Route;
}

/** 后端 net::TestResult */
interface TestResult {
  id: string;
  ok: boolean;
  via: Route;
  ms: number;
  fellBack: boolean;
  error: string | null;
}

const ROUTE_NAME: Record<Route, string> = { direct: "直连", system: "跟系统走" };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

function resultText(r: TestResult): string {
  if (!r.ok) return r.error ?? "连不上";
  if (r.fellBack) return `通了，但直连不通，改走系统路由 · ${secs(r.ms)}`;
  return `通了 · ${secs(r.ms)}`;
}

/** 设置里的「网络」：每个外部服务走哪条路，能改、能测（PRD 5.4「网络路线」） */
export function NetworkSettings() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [results, setResults] = useState<Record<string, TestResult | "busy">>({});
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    invoke<Service[]>("net_services")
      .then(setServices)
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void reload();
  }, []);

  const test = async (id: string) => {
    setResults((r) => ({ ...r, [id]: "busy" }));
    try {
      const r = await invoke<TestResult>("net_test", { id });
      setResults((all) => ({ ...all, [id]: r }));
    } catch (e) {
      setResults((all) => ({ ...all, [id]: { id, ok: false, via: "system", ms: 0, fellBack: false, error: String(e) } }));
    }
  };

  const setRoute = async (s: Service, route: Route) => {
    try {
      await invoke("net_set_route", { id: s.id, route: route === s.defaultRoute ? null : route });
      setResults(({ [s.id]: _, ...rest }) => rest);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!services) return error ? <p className="small error-text">{error}</p> : null;
  const busy = Object.values(results).some((r) => r === "busy");

  return (
    <div className="field net-settings">
      <label>网络</label>
      <p className="muted small">
        国内的服务「直连」：从 Wi-Fi / 网线直接出去，不进 VPN；国外的「跟系统走」：开着 VPN 就走 VPN。不用再去 VPN 里设分流。
      </p>
      <table className="net-table">
        <tbody>
          {services.map((s) => {
            const r = results[s.id];
            return (
              <tr key={s.id}>
                <td className="net-name">
                  <b>{s.name}</b>
                  <span className="muted small">{s.usedFor}</span>
                </td>
                <td>
                  <select value={s.route} onChange={(e) => void setRoute(s, e.target.value as Route)} aria-label={`${s.name}的路线`}>
                    {(["direct", "system"] as Route[]).map((route) => (
                      <option key={route} value={route}>
                        {ROUTE_NAME[route]}
                        {route === s.defaultRoute ? "（默认）" : ""}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Btn className="link" onClick={() => void test(s.id)} disabled={r === "busy"}>
                    测一下
                  </Btn>
                </td>
                <td className="net-result">
                  {r === "busy" ? (
                    <span className="muted small">正在连…</span>
                  ) : r ? (
                    <span className={r.ok ? (r.fellBack ? "small net-warn" : "small net-ok") : "small error-text"}>{resultText(r)}</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="field-row">
        <Btn className="ghost" onClick={() => services.forEach((s) => void test(s.id))} disabled={busy}>
          全部测一下
        </Btn>
      </div>
      {error && <p className="small error-text">{error}</p>}
    </div>
  );
}
