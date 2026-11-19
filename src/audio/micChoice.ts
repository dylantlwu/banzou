/**
 * 统一的「麦克风」选择（PRD 4.0「麦克风和出声设备」）：录音、录音校准、练声、直播、测试集录音都用设置里的同一个。
 * 设置项 `inputDevice`：
 *   ""          还没选过：自动挑一个（优先电脑内置，绝不默认挑蓝牙）
 *   "@system"   跟系统设置走（系统默认的麦克风）
 *   其它        设备名（按名字记住；WebKit 的 deviceId 每次可能不同）
 * 记住的设备没插上时：用系统默认的麦克风，并清楚地说出来，不悄悄换成别的。
 */
import { isBluetoothLabel, pickDefaultInput, type InputDevice } from "./recorder";

export const FOLLOW_SYSTEM = "@system";

/** 两个名字是不是同一个设备（浏览器可能加「Default - 」前缀或「(1234:abcd)」USB 编号） */
export function sameDevice(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/^(default|默认)\s*[-–—]\s*/i, "")
      .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "")
      .trim()
      .toLowerCase();
  return norm(a) === norm(b);
}

export interface MicPlan {
  /** 要打开的 WebKit deviceId；undefined = 系统默认 */
  deviceId: string | undefined;
  /** 记住的麦克风没插上：它的名字 */
  missing: string | null;
}

/** 按设置决定打开哪个麦克风（`inputs` 要带名字，也就是拿过麦克风权限之后列的） */
export function planMic(inputs: InputDevice[], choice: string): MicPlan {
  if (choice === FOLLOW_SYSTEM) return { deviceId: undefined, missing: null };
  if (choice) {
    const hit = inputs.find((d) => sameDevice(d.label, choice));
    return hit ? { deviceId: hit.deviceId, missing: null } : { deviceId: undefined, missing: choice };
  }
  return { deviceId: pickDefaultInput(inputs)?.deviceId, missing: null };
}

/** 记住的麦克风没插上时给用户的一句话 */
export function missingNotice(name: string, actual: string): string {
  return `记住的麦克风「${name}」没插上，现在用系统默认的麦克风${actual ? `「${actual}」` : ""}。插上后重新打开就会换回去；要换别的，在「声音 ▾」或 设置 → 耳机与录音 里换。`;
}

/** 下拉框里的一项 */
export interface DeviceOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * 「麦克风」下拉框：每个设备一项（蓝牙的不能选），加「跟系统设置」；
 * 记住的设备没插上时也列出来（标「没插上」），让用户看得见现在设的是什么。
 */
export function micOptions(names: { name: string; kind: string }[], choice: string, defaultName: string | null): DeviceOption[] {
  const opts: DeviceOption[] = [];
  if (!choice) opts.push({ value: "", label: "自动（不用蓝牙麦克风）" });
  for (const d of names) {
    const bt = d.kind === "bluetooth" || isBluetoothLabel(d.name);
    opts.push({ value: d.name, label: bt ? `${d.name}（蓝牙，不能用来录）` : d.name, disabled: bt });
  }
  if (choice && choice !== FOLLOW_SYSTEM && !names.some((d) => sameDevice(d.name, choice))) opts.push({ value: choice, label: `${choice}（没插上）` });
  opts.push({ value: FOLLOW_SYSTEM, label: `跟系统设置${defaultName ? `（现在是 ${defaultName}）` : ""}` });
  return opts;
}

interface MediaLike {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
}

function toInputs(all: MediaDeviceInfo[]): InputDevice[] {
  return all
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => ({ deviceId: d.deviceId, label: d.label, bluetooth: isBluetoothLabel(d.label) }));
}

/**
 * 按设置找出要打开的麦克风。WebKit 在这个页面还没拿过麦克风时不给设备名，
 * 这时先用系统默认的麦克风开一下再关掉，就能拿到名字了。
 */
export async function resolveMic(choice: string, media: MediaLike | undefined = navigator.mediaDevices): Promise<MicPlan & { inputs: InputDevice[] }> {
  if (!media?.enumerateDevices) return { deviceId: undefined, missing: null, inputs: [] };
  let inputs = toInputs(await media.enumerateDevices());
  if (choice !== FOLLOW_SYSTEM && inputs.length > 0 && inputs.every((d) => !d.label)) {
    const s = await media.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    inputs = toInputs(await media.enumerateDevices());
  }
  return { ...planMic(inputs, choice), inputs: inputs.map((d) => ({ ...d, label: d.label || "麦克风" })) };
}
