import { describe, expect, it, vi } from "vitest";
import { FOLLOW_SYSTEM, micOptions, missingNotice, planMic, resolveMic, sameDevice } from "./micChoice";

const PD = { deviceId: "pd-id", label: "PD200X Podcast Microphone", bluetooth: false };
const DOCK = { deviceId: "dock-id", label: "DL-Dock", bluetooth: false };
const POD = { deviceId: "pod-id", label: "小明的AirPods Pro", bluetooth: true };

describe("planMic", () => {
  it("选过的设备在：按名字找到它", () => {
    expect(planMic([DOCK, PD, POD], "PD200X Podcast Microphone")).toEqual({ deviceId: "pd-id", missing: null });
  });
  it("选过的设备没插上：用系统默认，并报出名字（不悄悄换成别的）", () => {
    expect(planMic([DOCK, POD], "PD200X Podcast Microphone")).toEqual({ deviceId: undefined, missing: "PD200X Podcast Microphone" });
  });
  it("跟系统设置：用系统默认", () => {
    expect(planMic([DOCK, PD], FOLLOW_SYSTEM)).toEqual({ deviceId: undefined, missing: null });
  });
  it("还没选过：自动挑，不挑蓝牙", () => {
    expect(planMic([POD, DOCK], "")).toEqual({ deviceId: "dock-id", missing: null });
  });
  it("名字带浏览器加的前缀或 USB 编号也认得", () => {
    expect(sameDevice("Default - PD200X Podcast Microphone (0d8c:0014)", "PD200X Podcast Microphone")).toBe(true);
    expect(sameDevice("DL-Dock", "PD200X Podcast Microphone")).toBe(false);
  });
});

describe("micOptions", () => {
  const names = [
    { name: "PD200X Podcast Microphone", kind: "usb" },
    { name: "AirPods", kind: "bluetooth" },
  ];
  it("列出设备，蓝牙的不能选，最后是「跟系统设置」", () => {
    const o = micOptions(names, "PD200X Podcast Microphone", "PD200X Podcast Microphone");
    expect(o.map((x) => x.value)).toEqual(["PD200X Podcast Microphone", "AirPods", FOLLOW_SYSTEM]);
    expect(o[1].disabled).toBe(true);
    expect(o[2].label).toBe("跟系统设置（现在是 PD200X Podcast Microphone）");
  });
  it("没选过时有「自动」一项", () => {
    expect(micOptions(names, "", null)[0]).toEqual({ value: "", label: "自动（不用蓝牙麦克风）" });
  });
  it("记住的设备没插上：也列出来，标「没插上」", () => {
    const o = micOptions(names, "DL-Dock", null);
    expect(o.find((x) => x.value === "DL-Dock")?.label).toBe("DL-Dock（没插上）");
  });
});

describe("resolveMic", () => {
  it("还没拿过权限（没有名字）时先用系统默认开一下，拿到名字再挑", async () => {
    const stop = vi.fn();
    let granted = false;
    const media = {
      enumerateDevices: vi.fn(async () =>
        [PD, DOCK].map((d) => ({ kind: "audioinput", deviceId: d.deviceId, label: granted ? d.label : "", groupId: "", toJSON() {} })) as MediaDeviceInfo[],
      ),
      getUserMedia: vi.fn(async () => {
        granted = true;
        return { getTracks: () => [{ stop }] } as unknown as MediaStream;
      }),
    };
    const r = await resolveMic("DL-Dock", media);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
    expect(r.deviceId).toBe("dock-id");
    expect(r.missing).toBeNull();
  });
  it("跟系统设置时不用先开", async () => {
    const media = { enumerateDevices: vi.fn(async () => [] as MediaDeviceInfo[]), getUserMedia: vi.fn() };
    expect((await resolveMic(FOLLOW_SYSTEM, media)).deviceId).toBeUndefined();
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
});

it("没插上的提示写清楚用了哪个", () => {
  expect(missingNotice("PD200X", "DL-Dock")).toContain("记住的麦克风「PD200X」没插上，现在用系统默认的麦克风「DL-Dock」");
});
