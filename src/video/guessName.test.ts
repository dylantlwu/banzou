import { describe, expect, it } from "vitest";
import { guessSongName } from "./guessName";

describe("guessSongName", () => {
  it("歌手【歌名】", () => {
    expect(guessSongName("曹格 Gary Chaw【寂寞先生】Official Music Video.mp4")).toBe("寂寞先生 曹格");
    expect(guessSongName("盧廣仲 Crowd Lu 【幾分之幾 You Complete Me】 Official Music Video （花甲大人轉男孩電影主題曲）.mp4")).toBe("幾分之幾 盧廣仲");
    expect(guessSongName("盧廣仲 Crowd Lu【太陽與地球 Sun & Earth】Official Video")).toBe("太陽與地球 盧廣仲");
  });

  it("【歌手】歌名 ⧸ 别名", () => {
    expect(guessSongName("【AKASAKI】夏実 ⧸ Kajitsu（Lyric Video）.mp4")).toBe("夏実 AKASAKI");
    expect(guessSongName("【AKASAKI】夏実 / Kajitsu (Lyric Video)")).toBe("夏実 AKASAKI");
  });

  it("歌手 - 歌名 (Official Video)", () => {
    expect(guessSongName("Teddy Swims - The Door (Official Music Video).mp4")).toBe("The Door Teddy Swims");
    expect(guessSongName("Teddy Swims - Lose Control (Lyric Video)")).toBe("Lose Control Teddy Swims");
  });

  it("《歌名》.歌手 和其他写法", () => {
    expect(guessSongName("《菩薩魚》.金魚精  《菩萨鱼》.金鱼精.mp4")).toBe("菩薩魚 金魚精");
    expect(guessSongName("[🪷] 李白 Neo Soul Reimagined （原唱：李荣浩）.mp4")).toBe("李白 Neo Soul Reimagined");
    expect(guessSongName("Me at the zoo.mp4")).toBe("Me at the zoo");
  });
});
