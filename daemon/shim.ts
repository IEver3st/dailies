import { copyFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ffmpeg = process.env.DAILIES_FFMPEG || "ffmpeg";
const jobDir = process.env.DAILIES_JOB;
const encoder = process.env.DAILIES_ENCODER || "libx264";
const gop = Number(process.env.DAILIES_GOP || "60");

function rewriteEncode(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-c:v" && args[i + 1] === "libx264") {
      i++;
      if (encoder === "h264_amf") {
        out.push("-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed", "-rc", "cqp", "-qp_i", "19", "-qp_p", "21", "-bf", "0", "-forced_idr", "1");
      } else {
        out.push("-c:v", "libx264", "-preset", "veryfast", "-tune", "fastdecode", "-crf", "19", "-bf", "0", "-sc_threshold", "0");
      }
      continue;
    }
    if (a === "-b:v") {
      i++;
      continue;
    }
    if (a === "-g") {
      i++;
      out.push("-g", String(gop), "-force_key_frames", `expr:gte(n,n_forced*${gop})`);
      continue;
    }
    out.push(a);
  }
  return out;
}

const args = process.argv.slice(2);
const isEncode = args.includes("rawvideo") && args.includes("pipe:0");
const wav = args.find((a) => a.toLowerCase().endsWith(".wav"));
const finalArgs = isEncode ? rewriteEncode(args) : args;

if (jobDir) {
  try {
    mkdirSync(jobDir, { recursive: true });
    appendFileSync(join(jobDir, "shim.log"), JSON.stringify(finalArgs) + "\n");
    if (!isEncode && wav) copyFileSync(wav, join(jobDir, "audio.wav"));
  } catch (e) {
    appendFileSync(join(jobDir, "shim.log"), `error ${String(e)}\n`);
  }
}

const proc = Bun.spawn([ffmpeg, ...finalArgs], { stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
process.exit(await proc.exited);
