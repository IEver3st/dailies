import { existsSync, readdirSync, renameSync, readFileSync, writeFileSync, mkdirSync, rmSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { SLATE_CACHE } from "./paths";

export const FFMPEG = process.env.DAILIES_FFMPEG || findOnPath("ffmpeg") || "ffmpeg";

function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(";");
  for (const d of dirs) {
    const p = join(d, `${name}.exe`);
    if (d && existsSync(p)) return p;
  }
  return undefined;
}

export async function run(args: string[], input?: Uint8Array): Promise<{ code: number; stderr: string; stdout: Uint8Array }> {
  const p = Bun.spawn(args, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (input) {
    (p.stdin as any).write(input);
    (p.stdin as any).end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  return { code, stderr, stdout: new Uint8Array(stdout) };
}

async function ffmpeg(args: string[], input?: Uint8Array) {
  const r = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], input);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return r;
}

let encoderProbe: Promise<string> | undefined;
export function pickEncoder(): Promise<string> {
  encoderProbe ??= (async () => {
    if (process.env.DAILIES_ENCODER) return process.env.DAILIES_ENCODER;
    const r = await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30:d=0.2", "-c:v", "h264_amf", "-f", "null", "-"]);
    return r.code === 0 ? "h264_amf" : "libx264";
  })();
  return encoderProbe;
}

export async function splitSpan(opts: {
  spanFile: string;
  workDir: string;
  firstSegment: number;
  segmentCount: number;
  lastSegmentMs: number;
}): Promise<string[]> {
  const dir = join(opts.workDir, "seg");
  mkdirSync(dir, { recursive: true });
  const times = Array.from({ length: Math.max(0, opts.segmentCount - 1) }, (_, i) => String(i + 1)).join(",");
  const args = ["-i", opts.spanFile, "-map", "0:v:0", "-c", "copy", "-f", "segment", "-reset_timestamps", "1", "-segment_format", "mp4", "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof"];
  if (times) args.push("-segment_times", times);
  args.push(join(dir, "%04d.mp4"));
  await ffmpeg(args);
  const files = readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort();
  if (files.length !== opts.segmentCount) throw new Error(`expected ${opts.segmentCount} segments from span, got ${files.length}`);
  return files.map((f) => join(dir, f));
}

export type Wav = { sampleRate: number; channels: number; bitsPerSample: number; data: Buffer };

export function readWav(file: string): Wav {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let p = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    let size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt ") {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt");
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, data: buf.subarray(body, body + size) };
    }
    p = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

export const PCM_RATE = 48000;
export const PCM_CHANNELS = 2;
export const PCM_BYTES_PER_FRAME = 4;

export function sliceWav(wav: Wav, segmentCount: number, segmentMsList: number[]): Buffer[] {
  if (wav.sampleRate !== PCM_RATE || wav.channels !== PCM_CHANNELS || wav.bitsPerSample !== 16) {
    throw new Error(`unexpected WAV format ${wav.sampleRate}/${wav.channels}/${wav.bitsPerSample}`);
  }
  const out: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < segmentCount; i++) {
    const frames = Math.round((segmentMsList[i] * PCM_RATE) / 1000);
    const bytes = frames * PCM_BYTES_PER_FRAME;
    const slice = Buffer.alloc(bytes);
    wav.data.copy(slice, 0, offset, Math.min(wav.data.length, offset + bytes));
    out.push(slice);
    offset += bytes;
  }
  return out;
}

export async function encodeMovie(video: string[], audio: (string | undefined)[], lengths: number[], outFile: string) {
  const total = lengths.reduce((a, b) => a + b, 0);
  const pcm = Buffer.alloc(Math.round((total * PCM_RATE) / 1000) * PCM_BYTES_PER_FRAME);
  let offset = 0;
  audio.forEach((f, i) => {
    const bytes = Math.round((lengths[i] * PCM_RATE) / 1000) * PCM_BYTES_PER_FRAME;
    if (f && existsSync(f)) readFileSync(f).copy(pcm, offset, 0, bytes);
    offset += bytes;
  });
  const list = `${outFile}.txt`;
  writeFileSync(list, video.map((f) => `file '${f.split(String.fromCharCode(92)).join("/")}'`).join(String.fromCharCode(10)));
  const tmp = `${outFile}.part.mp4`;
  try {
    await ffmpeg(
      ["-f", "concat", "-safe", "0", "-i", list, "-f", "s16le", "-ar", String(PCM_RATE), "-ac", String(PCM_CHANNELS), "-i", "pipe:0", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "flac", "-movflags", "+faststart", "-f", "mp4", tmp],
      pcm,
    );
    renameSync(tmp, outFile);
  } finally {
    rmSync(list, { force: true });
    rmSync(tmp, { force: true });
  }
}

const slates = new Map<string, Promise<string>>();
export function makeSlate(width: number, height: number, ms: number, fps: number): Promise<string> {
  const key = `${width}x${height}-${ms}-${fps}`;
  let p = slates.get(key);
  if (!p) {
    p = (async () => {
      const out = join(SLATE_CACHE, `slate-${key}.mp4`);
      if (existsSync(out)) return out;
      const encoder = await pickEncoder();
      const frames = Math.max(1, Math.round((ms * fps) / 1000));
      const enc = encoder === "h264_amf"
        ? ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed", "-rc", "cqp", "-qp_i", "19", "-qp_p", "21", "-bf", "0", "-forced_idr", "1"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-bf", "0"];
      const tmp = `${out}.part.mp4`;
      await ffmpeg(["-f", "lavfi", "-i", `color=c=0x16171a:s=${width}x${height}:r=${fps}`, "-frames:v", String(frames), ...enc, "-g", String(fps), "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", tmp]);
      renameSync(tmp, out);
      return out;
    })();
    slates.set(key, p);
  }
  return p;
}

export async function extractFrame(segmentFile: string, frameIndex: number, outPng: string) {
  const tmp = `${outPng}.part.png`;
  try {
    await ffmpeg(["-i", segmentFile, "-vf", `select=eq(n\\,${Math.max(0, Math.floor(frameIndex))})`, "-fps_mode", "passthrough", "-frames:v", "1", "-update", "1", tmp]);
    if (!existsSync(tmp)) await ffmpeg(["-sseof", "-0.1", "-i", segmentFile, "-frames:v", "1", "-update", "1", tmp]);
    if (!existsSync(tmp)) throw new Error(`no frame ${frameIndex} in ${segmentFile}`);
    renameSync(tmp, outPng);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export const THUMB_SHORT_SIDE = 240;

export async function extractThumb(segmentFile: string, outJpg: string, shortSide = THUMB_SHORT_SIDE) {
  const tmp = `${outJpg}.part.jpg`;
  const scale = `scale=w='if(gt(iw\\,ih)\\,-2\\,${shortSide})':h='if(gt(iw\\,ih)\\,${shortSide}\\,-2)':flags=bicubic`;
  try {
    await ffmpeg(["-i", segmentFile, "-vf", `select=eq(n\\,0),${scale}`, "-fps_mode", "passthrough", "-frames:v", "1", "-q:v", "4", "-update", "1", tmp]);
    if (!existsSync(tmp)) throw new Error(`no thumbnail from ${segmentFile}`);
    renameSync(tmp, outJpg);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function probeVideo(file: string) {
  const r = await run([FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,level,width,height", "-of", "json", file]);
  return JSON.parse(new TextDecoder().decode(r.stdout)).streams?.[0];
}

export function fileSize(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function moveInto(src: string, dest: string) {
  if (existsSync(dest)) {
    rmSync(src, { force: true });
    return;
  }
  renameSync(src, dest);
}

export function writeBuffer(file: string, data: Buffer) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function readHead(file: string, bytes: number) {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(bytes);
    const n = readSync(fd, b, 0, bytes, 0);
    return b.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}
