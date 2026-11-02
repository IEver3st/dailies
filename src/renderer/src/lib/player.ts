import { useSyncExternalStore } from "react";
import { FPS, frameAt } from "./format";

export type PlayerState = { time: number; playing: boolean; rate: number; muted: boolean; volume: number; loop?: { in: number; out: number }; durationMs: number };

const AUDIO_KEY = "dailies-audio";

function savedAudio(): { volume: number; muted: boolean } {
  try {
    const { volume, muted } = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? "{}");
    return { volume: typeof volume === "number" ? Math.max(0, Math.min(1, volume)) : 1, muted: muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

export class PlayerController {
  video?: HTMLVideoElement;
  state: PlayerState = { time: 0, playing: false, rate: 1, durationMs: 0, ...savedAudio() };
  private subs = new Set<() => void>();
  private cbId?: number;
  private shuttle = 0;
  private queuedSeek?: number;
  private cmp?: HTMLVideoElement;
  private cmpCb?: number;
  private cmpFrame?: { now: number; media: number };
  private cmpAhead = 0;
  onTime?: (ms: number) => void;

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  get compare() {
    return this.cmp;
  }
  set compare(c: HTMLVideoElement | undefined) {
    if (c === this.cmp) return;
    if (this.cmp && this.cmpCb !== undefined) this.cmp.cancelVideoFrameCallback(this.cmpCb);
    this.cmp = c;
    this.cmpCb = undefined;
    this.cmpFrame = undefined;
    this.cmpAhead = 0;
    if (!c) return;
    const tick = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (this.cmp !== c) return;
      this.cmpFrame = { now, media: meta.mediaTime };
      this.cmpCb = c.requestVideoFrameCallback(tick);
    };
    this.cmpCb = c.requestVideoFrameCallback(tick);
  }

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const s of this.subs) s();
  }

  attach(v: HTMLVideoElement) {
    if (this.video && this.cbId !== undefined) this.video.cancelVideoFrameCallback(this.cbId);
    this.video = v;
    this.queuedSeek = undefined;
    v.playbackRate = this.state.rate;
    this.applyAudio(v);
    v.onplay = () => this.set({ playing: true });
    v.onpause = () => {
      if (this.video === v) this.set({ playing: false, time: v.currentTime * 1000 });
      this.syncCompare(true);
    };
    v.onseeked = () => {
      if (this.video !== v) return;
      if (this.queuedSeek !== undefined) {
        v.currentTime = this.queuedSeek / 1000;
        this.queuedSeek = undefined;
        return;
      }
      this.set({ time: v.currentTime * 1000 });
      this.syncCompare(true);
    };
    v.onended = () => this.set({ playing: false });
    v.ondurationchange = () => this.set({ durationMs: (v.duration || 0) * 1000 });
    if (v.duration) this.set({ durationMs: v.duration * 1000 });
    this.loopFrames(v);
  }

  private loopFrames(v: HTMLVideoElement) {
    const tick = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (this.video !== v) return;
      const t = meta.mediaTime * 1000;
      const loop = this.state.loop;
      if (loop && this.state.playing && t >= loop.out) {
        v.currentTime = loop.in / 1000;
      }
      if (this.queuedSeek === undefined && !v.seeking) {
        this.state = { ...this.state, time: t };
        for (const s of this.subs) s();
      }
      this.onTime?.(t);
      this.syncCompare(false, now, meta.mediaTime);
      this.cbId = v.requestVideoFrameCallback(tick);
    };
    this.cbId = v.requestVideoFrameCallback(tick);
  }

  syncCompare(hard: boolean, now?: number, media?: number) {
    const c = this.cmp;
    const v = this.video;
    if (!c || !v || !c.src) return;
    if (v.paused && !c.paused) c.pause();
    if (!v.paused && c.paused) void c.play().catch(() => {});
    const realign = () => {
      c.playbackRate = v.playbackRate;
      c.currentTime = Math.min(v.currentTime, (c.duration || Infinity) - 0.001);
      this.cmpFrame = undefined;
      this.cmpAhead = 0;
    };
    if (hard) {
      if (Math.abs(c.currentTime - v.currentTime) > 0.002) realign();
      else c.playbackRate = v.playbackRate;
      return;
    }
    const f = this.cmpFrame;
    if (v.paused || c.paused || now === undefined || media === undefined || !f) return;
    const sample = f.media + ((now - f.now) / 1000) * c.playbackRate - media;
    if (Math.abs(sample) > 0.25) return realign();
    this.cmpAhead += (sample - this.cmpAhead) * 0.15;
    const ahead = this.cmpAhead;
    const rate = Math.abs(ahead) < 0.6 / FPS ? v.playbackRate : v.playbackRate * (1 - Math.max(-0.1, Math.min(0.1, ahead * 2)));
    if (c.playbackRate !== rate) c.playbackRate = rate;
  }

  play() {
    const v = this.video;
    if (!v) return;
    if (this.state.loop && (v.currentTime * 1000 >= this.state.loop.out || v.currentTime * 1000 < this.state.loop.in)) v.currentTime = this.state.loop.in / 1000;
    else if (v.ended || v.currentTime >= v.duration - 0.01) v.currentTime = 0;
    void v.play().catch(() => {});
  }
  pause() {
    if (this.shuttle) {
      this.shuttle = 0;
      this.setRate(1);
    }
    this.video?.pause();
  }
  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }
  seek(ms: number) {
    const v = this.video;
    const d = this.state.durationMs || (v?.duration ?? 0) * 1000;
    const t = Math.max(0, Math.min(d ? d - 1000 / FPS / 2 : ms, ms));
    this.set({ time: t });
    if (!v) return;
    if (v.seeking) this.queuedSeek = t;
    else v.currentTime = t / 1000;
  }
  frame() {
    return frameAt(this.state.time);
  }
  step(frames: number) {
    this.pause();
    const f = Math.max(0, this.frame() + frames);
    this.seek(((f + 0.5) / FPS) * 1000);
  }
  setRate(rate: number) {
    this.set({ rate });
    if (this.video) this.video.playbackRate = rate;
  }
  applyAudio(v: HTMLVideoElement) {
    v.volume = this.state.volume ** 2;
    v.muted = this.state.muted || this.state.volume === 0;
  }
  private setAudio(volume: number, muted: boolean) {
    this.set({ volume: Math.round(Math.max(0, Math.min(1, volume)) * 100) / 100, muted });
    if (this.video) this.applyAudio(this.video);
    localStorage.setItem(AUDIO_KEY, JSON.stringify({ volume: this.state.volume, muted: this.state.muted }));
  }
  setMuted(muted: boolean) {
    this.setAudio(!muted && this.state.volume === 0 ? 0.5 : this.state.volume, muted);
  }
  setVolume(volume: number) {
    this.setAudio(volume, false);
  }
  nudgeVolume(delta: number) {
    if (this.state.muted && delta < 0) return;
    this.setVolume(this.state.volume + delta);
  }
  setLoop(loop: PlayerState["loop"]) {
    this.set({ loop });
  }
  shuttleForward() {
    this.shuttle = this.shuttle <= 0 ? 1 : Math.min(4, this.shuttle * 2);
    this.setRate(this.shuttle);
    this.play();
  }
  shuttleBack() {
    this.pause();
    this.step(-Math.round(FPS / 2));
  }
}

export function usePlayerSelect<T>(c: PlayerController, select: (s: PlayerState) => T) {
  return useSyncExternalStore(c.subscribe, () => select(c.state));
}
