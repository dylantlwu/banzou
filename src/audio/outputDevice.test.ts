import { describe, expect, it } from "vitest";
import { clockStalled, defaultChanged, type OutputsSnapshot } from "./outputDevice";

const PD = { uid: "usb:pd200x:2", name: "PD200X Podcast Microphone", kind: "usb" };
const MAC = { uid: "BuiltInSpeakerDevice", name: "Mac mini扬声器", kind: "speaker" };
const POD = { uid: "airpods", name: "AirPods", kind: "bluetooth" };

const snap = (defaultUid: string | null, devices = [PD, MAC]): OutputsSnapshot => ({ devices, defaultUid });

describe("defaultChanged", () => {
  it("用户在控制中心从 Mac mini 切到 PD200X：算换了", () => {
    expect(defaultChanged(snap(MAC.uid), snap(PD.uid))).toBe(true);
  });
  it("默认没变、只是连上了 AirPods：不算", () => {
    expect(defaultChanged(snap(MAC.uid), snap(MAC.uid, [PD, MAC, POD]))).toBe(false);
  });
  it("第一次拿到设备列表不算（应用打开时本来就用当时的默认设备）", () => {
    expect(defaultChanged(null, snap(PD.uid))).toBe(false);
  });
  it("默认设备拔掉了（暂时读不到）也算，让播放器检查一下", () => {
    expect(defaultChanged(snap(PD.uid), snap(null, [MAC]))).toBe(true);
  });
});

describe("clockStalled", () => {
  it("时钟在走", () => {
    expect(clockStalled(10, 10.5, 500)).toBe(false);
  });
  it("时钟几乎没动：卡住了", () => {
    expect(clockStalled(10, 10.01, 500)).toBe(true);
  });
  it("间隔太短不下结论", () => {
    expect(clockStalled(10, 10, 50)).toBe(false);
  });
});
