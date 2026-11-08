/**
 * 播放位置的纯逻辑：根据音频时钟推算当前歌曲位置。
 * 时钟通过构造参数注入，方便单元测试。
 */
export class Transport {
  private startClock = 0;
  private startOffset = 0;
  private _playing = false;
  private _rate = 1;

  constructor(
    private readonly now: () => number,
    public duration = 0,
  ) {}

  get playing(): boolean {
    return this._playing;
  }

  /** 播放速度（1 = 原速） */
  get rate(): number {
    return this._rate;
  }

  private clamp(t: number): number {
    return Math.min(Math.max(t, 0), this.duration);
  }

  /** 当前歌曲位置（秒） */
  position(): number {
    if (!this._playing) return this.startOffset;
    return this.clamp(this.startOffset + Math.max(0, this.now() - this.startClock) * this._rate);
  }

  /**
   * 开始播放。`at` 是音源真正开始发声的时钟时刻（可以略晚于现在）。
   * 返回音源应从歌曲的哪个位置开始播放。
   */
  play(at: number = this.now()): number {
    if (this._playing) return this.position();
    if (this.startOffset >= this.duration) this.startOffset = 0;
    this.startClock = at;
    this._playing = true;
    return this.startOffset;
  }

  pause(): void {
    if (!this._playing) return;
    this.startOffset = this.position();
    this._playing = false;
  }

  /** 跳转。播放中时 `at` 同样是音源重新发声的时钟时刻 */
  seek(t: number, at: number = this.now()): number {
    this.startOffset = this.clamp(t);
    if (this._playing) this.startClock = at;
    return this.startOffset;
  }

  /** 改变速度：以当前位置为新起点继续推算 */
  setRate(rate: number, at: number = this.now()): void {
    if (this._playing) {
      this.startOffset = this.position();
      this.startClock = at;
    }
    this._rate = rate;
  }

  /**
   * 某个时钟时刻对应的歌曲位置（不截断，可以是负数或超过结尾）。
   * 录音用：麦克风某一帧的时钟时刻 → 这时伴奏放到哪了。
   */
  positionAtClock(clock: number): number {
    if (!this._playing) return this.startOffset;
    return this.startOffset + (clock - this.startClock) * this._rate;
  }

  /** 是否已播到结尾 */
  atEnd(): boolean {
    return this.duration > 0 && this.position() >= this.duration;
  }

  reset(duration = 0): void {
    this._playing = false;
    this.startOffset = 0;
    this.startClock = 0;
    this.duration = duration;
  }
}
