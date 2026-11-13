import { describe, expect, it } from "vitest";
import { AUTO_STOP_EXTRA_SECONDS, formatLength, formatSize, overRecordLimit } from "./recordGuard";

describe("录音超长自动停", () => {
  it("超过 歌长 + 30 秒才停", () => {
    expect(AUTO_STOP_EXTRA_SECONDS).toBe(30);
    expect(overRecordLimit(200, 180)).toBe(false);
    expect(overRecordLimit(210, 180)).toBe(false);
    expect(overRecordLimit(210.1, 180)).toBe(true);
  });

  it("不知道歌长不自动停", () => {
    expect(overRecordLimit(99999, 0)).toBe(false);
  });
});

describe("异常录音的显示", () => {
  it("大小", () => {
    expect(formatSize(2.4 * 1024 ** 3)).toBe("2.4 GB");
    expect(formatSize(350 * 1024 ** 2)).toBe("350 MB");
    expect(formatSize(100)).toBe("1 MB");
  });

  it("长度", () => {
    expect(formatLength(3.5 * 3600)).toBe("约 3.5 小时");
    expect(formatLength(2 * 3600)).toBe("约 2 小时");
    expect(formatLength(16 * 60 + 10)).toBe("约 16 分钟");
    expect(formatLength(42)).toBe("约 42 秒");
  });
});
