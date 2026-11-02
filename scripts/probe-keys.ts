import { listZip, readZipJson } from "../daemon/zip";
import { analyze } from "../daemon/doc";

const p = process.argv[2];
const entries = listZip(p);
const doc: any = readZipJson(p, "project.json", entries);
const meta: any = readZipJson(p, "metadata.json", entries);
const S = { fps: 60, resolution: "1080p" };
const base = analyze(doc, meta.assets, S);
const dirty = (d: any) => {
  const b = analyze(d, meta.assets, S);
  return {
    v: b.vkeys.flatMap((k, i) => (k !== base.vkeys[i] ? [i] : [])),
    a: b.akeys.flatMap((k, i) => (k !== base.akeys[i] ? [i] : [])),
  };
};
const L = doc.composition.layers;
const find = (pred: (l: any) => boolean) => L.findIndex(pred);
let d = structuredClone(doc);
const music = find((l: any) => l.type === "Audio" && /Music/.test(l.name));
d.composition.layers[music].volume = 0.3;
console.log("music volume", dirty(d));
d = structuredClone(doc);
const vid = find((l: any) => l.type === "Video");
d.composition.layers[vid].volume = 0.5;
console.log("video volume", L[vid].name, dirty(d));
d = structuredClone(doc);
const [x] = d.composition.layers.splice(vid, 1);
d.composition.layers.push(x);
console.log("reorder video to end", dirty(d));
d = structuredClone(doc);
d.composition.name = "Renamed";
console.log("rename comp", dirty(d));
d = structuredClone(doc);
d.duration = doc.duration - 0.5;
console.log("trim end 0.5s", dirty(d));
d = structuredClone(doc);
d.composition.layers.push({ id: 9999, type: "Rect", name: "x", activeRange: { start: 0, duration: 500 } });
console.log("add rect at 0-0.5s", dirty(d));
const cap = find((l: any) => l.type === "Group" && /Caption/.test(l.name));
d = structuredClone(doc);
d.composition.layers[cap].layers[0].sourceText.text = "changed";
console.log("caption text", L[cap].name, dirty(d));
