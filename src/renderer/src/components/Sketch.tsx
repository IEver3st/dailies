import { useLayoutEffect, useRef, useState } from "react";
import type { Annotation } from "@/lib/api";

export type Tool = "rect" | "arrow" | "pen" | "pin";

const AMBER = "#ffb238";

function Shape({ a, w, h, color = AMBER, faded }: { a: Annotation; w: number; h: number; color?: string; faded?: boolean }) {
  const sw = 3;
  const common = { stroke: color, strokeWidth: sw, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, opacity: faded ? 0.55 : 1 };
  if (a.kind === "rect") return <rect x={a.x * w} y={a.y * h} width={a.w * w} height={a.h * h} rx={6} {...common} />;
  if (a.kind === "pen") return <polyline points={a.points.map(([x, y]) => `${x * w},${y * h}`).join(" ")} {...common} />;
  if (a.kind === "pin") {
    const cx = a.x * w;
    const cy = a.y * h;
    return (
      <g opacity={faded ? 0.55 : 1}>
        <circle cx={cx} cy={cy} r={11} fill={color} stroke="rgba(0,0,0,.35)" strokeWidth={1} />
        <circle cx={cx} cy={cy} r={3.5} fill="#241703" />
      </g>
    );
  }
  const x1 = a.x1 * w;
  const y1 = a.y1 * h;
  const x2 = a.x2 * w;
  const y2 = a.y2 * h;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = 16;
  const p1 = `${x2 - head * Math.cos(ang - 0.45)},${y2 - head * Math.sin(ang - 0.45)}`;
  const p2 = `${x2 - head * Math.cos(ang + 0.45)},${y2 - head * Math.sin(ang + 0.45)}`;
  return (
    <g {...common}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <polyline points={`${p1} ${x2},${y2} ${p2}`} />
    </g>
  );
}

export function Sketch({ tool, pending, shown, onAdd }: { tool?: Tool; pending: Annotation[]; shown: Annotation[]; onAdd: (a: Annotation) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<Annotation>();

  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const norm = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  };

  const down = (e: React.PointerEvent) => {
    if (!tool) return;
    e.preventDefault();
    e.stopPropagation();
    const [x0, y0] = norm(e);
    if (tool === "pin") {
      onAdd({ kind: "pin", x: x0, y: y0 });
      return;
    }
    let cur: Annotation = tool === "rect" ? { kind: "rect", x: x0, y: y0, w: 0, h: 0 } : tool === "arrow" ? { kind: "arrow", x1: x0, y1: y0, x2: x0, y2: y0 } : { kind: "pen", points: [[x0, y0]] };
    setDraft(cur);
    const move = (ev: PointerEvent) => {
      const [x, y] = norm(ev);
      if (cur.kind === "rect") cur = { kind: "rect", x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      else if (cur.kind === "arrow") cur = { ...cur, x2: x, y2: y };
      else if (cur.kind === "pen") cur = { kind: "pen", points: [...cur.points, [x, y]] };
      setDraft(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(undefined);
      const big = cur.kind === "rect" ? cur.w > 0.01 && cur.h > 0.006 : cur.kind === "arrow" ? Math.hypot(cur.x2 - cur.x1, cur.y2 - cur.y1) > 0.02 : cur.kind === "pen" ? cur.points.length > 2 : true;
      if (big) onAdd(cur.kind === "pen" ? { kind: "pen", points: cur.points.filter((_, i, arr) => i % 2 === 0 || i === arr.length - 1).map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]) } : cur);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <svg ref={ref} className="size-full" style={{ cursor: tool ? "crosshair" : "default", pointerEvents: tool ? "auto" : "none" }} onPointerDown={down}>
      {shown.map((a, i) => (
        <Shape key={`s${i}`} a={a} w={size.w} h={size.h} faded />
      ))}
      {pending.map((a, i) => (
        <Shape key={`p${i}`} a={a} w={size.w} h={size.h} />
      ))}
      {draft && <Shape a={draft} w={size.w} h={size.h} />}
    </svg>
  );
}

export function drawAnnotations(ctx: CanvasRenderingContext2D, list: Annotation[], w: number, h: number) {
  const scale = Math.max(1, w / 540);
  ctx.strokeStyle = AMBER;
  ctx.fillStyle = AMBER;
  ctx.lineWidth = 3 * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const a of list) {
    ctx.beginPath();
    if (a.kind === "rect") ctx.roundRect(a.x * w, a.y * h, a.w * w, a.h * h, 6 * scale);
    else if (a.kind === "pen") a.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    else if (a.kind === "pin") {
      ctx.arc(a.x * w, a.y * h, 11 * scale, 0, Math.PI * 2);
      ctx.fill();
      continue;
    } else {
      const ang = Math.atan2((a.y2 - a.y1) * h, (a.x2 - a.x1) * w);
      const head = 16 * scale;
      ctx.moveTo(a.x1 * w, a.y1 * h);
      ctx.lineTo(a.x2 * w, a.y2 * h);
      ctx.moveTo(a.x2 * w - head * Math.cos(ang - 0.45), a.y2 * h - head * Math.sin(ang - 0.45));
      ctx.lineTo(a.x2 * w, a.y2 * h);
      ctx.lineTo(a.x2 * w - head * Math.cos(ang + 0.45), a.y2 * h - head * Math.sin(ang + 0.45));
    }
    ctx.stroke();
  }
}
