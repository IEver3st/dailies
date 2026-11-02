import { useEffect, useState } from "react";
import { Film } from "lucide-react";
import { cn } from "@/lib/format";

export function Img({ src, className }: { src?: string; className?: string }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  useEffect(() => setState("loading"), [src]);
  if (!src || state === "failed") return null;
  return (
    <img
      src={src}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setState("ok")}
      onError={() => setState("failed")}
      className={cn("absolute inset-0 size-full object-cover transition-opacity duration-200", state === "ok" ? "opacity-100" : "opacity-0", className)}
    />
  );
}

export function Blank({ className }: { className?: string }) {
  return (
    <div className={cn("absolute inset-0 grid place-items-center text-faint", className)}>
      <Film className="size-5" strokeWidth={1.6} />
    </div>
  );
}
