import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { exportSpan, findCli } from "../daemon/tsrct";
import { SHIM } from "../daemon/render";
import { FFMPEG, pickEncoder } from "../daemon/media";

const [project, outRoot] = process.argv.slice(2);
const cli = findCli();
const encoder = await pickEncoder();
async function go(name: string, resolution: string, fps: number, startMs: number, durationMs: number) {
  const dir = join(outRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const ex = exportSpan({ cli, project, output: join(dir, "span.mp4"), resolution, fps, startMs, durationMs, shim: SHIM, env: { DAILIES_JOB: dir, DAILIES_ENCODER: encoder, DAILIES_GOP: String(fps), DAILIES_FFMPEG: FFMPEG } });
  await ex.done;
  const wav = join(dir, "audio.wav");
  return { ms: Date.now() - t0, wav: existsSync(wav) ? readFileSync(wav) : undefined };
}
for (const [s, d] of [[13000, 2869]]) {
  const a = await go(`full-${s}`, "1080p", 60, s, d);
  const b = await go(`lite-${s}`, "720p", 1, s, d);
  const same = a.wav && b.wav && Buffer.compare(a.wav, b.wav) === 0;
  console.log(JSON.stringify({ span: [s, d], fullMs: a.ms, liteMs: b.ms, fullBytes: a.wav?.length, liteBytes: b.wav?.length, identical: same }));
}
