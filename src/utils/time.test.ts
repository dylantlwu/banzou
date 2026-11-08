import { expect, it } from "vitest";
import { formatTime } from "./time";

it("formatTime 格式化为 m:ss", () => {
  expect(formatTime(0)).toBe("0:00");
  expect(formatTime(9.9)).toBe("0:09");
  expect(formatTime(287.01)).toBe("4:47");
  expect(formatTime(3600)).toBe("60:00");
  expect(formatTime(-1)).toBe("0:00");
  expect(formatTime(NaN)).toBe("0:00");
});
