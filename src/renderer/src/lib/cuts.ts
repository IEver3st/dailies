import { media, type CutSummary } from "./api";

export const WORKING_MS = 15 * 60_000;

export const isWorking = (c: CutSummary) => c.agent?.state === "working" && Date.now() - Date.parse(c.agent.at) < WORKING_MS;
export const awaitingReview = (c: CutSummary) => !!c.latest && c.latest.author.kind === "agent" && c.approvedRev !== c.latest.n;
export const needsYou = (c: CutSummary) => !c.missing && !isWorking(c) && (c.agent?.state === "blocked" || c.draftNotes > 0 || awaitingReview(c));

export function cutPoster(c: CutSummary) {
  if (!c.latest) return undefined;
  return media(`/api/cuts/${c.id}/poster?rev=${c.latest.n}${c.render.rendering ? `&r=${c.render.ready}` : ""}`);
}
