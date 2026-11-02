import { useEffect, useRef, useState, useCallback } from "react";
import { api, onEvent, type ActivityItem, type CutDetail, type CutSummary, type LibraryFile } from "./api";

export function useCuts() {
  const [cuts, setCuts] = useState<CutSummary[]>();
  const [library, setLibrary] = useState<LibraryFile[]>([]);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const s = await api<{ cuts: CutSummary[] }>("/api/state");
      setCuts(s.cuts);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const refreshLibrary = useCallback(async () => {
    try {
      const l = await api<{ files: LibraryFile[] }>("/api/library");
      setLibrary(l.files);
    } catch {}
  }, []);
  useEffect(() => {
    void refresh();
    void refreshLibrary();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => {
      if (e.type === "ping" || e.type === "hello") return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 200);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [refresh, refreshLibrary]);
  return { cuts, library, error, refresh, refreshLibrary };
}

export function useCut(cutId: string, rev?: number) {
  const [cut, setCut] = useState<CutDetail>();
  const [error, setError] = useState<string>();
  const revRef = useRef(rev);
  revRef.current = rev;
  const refresh = useCallback(async () => {
    try {
      const d = await api<CutDetail>(`/api/cuts/${cutId}${revRef.current !== undefined ? `?rev=${revRef.current}` : ""}`);
      setCut(d);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cutId]);
  useEffect(() => {
    void refresh();
  }, [refresh, rev]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => {
      if (e.type === "ping" || e.type === "hello") return;
      if (e.cutId && e.cutId !== cutId) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), e.type === "render" ? 350 : 80);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [cutId, refresh]);
  return { cut, error, refresh };
}

export function useActivity(limit = 80) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ items: ActivityItem[] }>(`/api/activity?limit=${limit}`)
        .then((r) => alive && setItems(r.items))
        .catch(() => {});
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((e) => {
      if (e.type === "ping" || e.type === "hello" || e.type === "render") return;
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => {
      alive = false;
      off();
      clearTimeout(timer);
    };
  }, [limit]);
  return items;
}
