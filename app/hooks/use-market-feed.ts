"use client";

import { useEffect, useState } from "react";
import { MarketFeedController, type ReferenceRequest } from "../lib/market-feed";
import { parseOfficialPrice, type OfficialPrice } from "../lib/polymarket-data";

/** Official price-to-beat via the same-origin proxy (the upstream sends no CORS headers). */
const fetchReferences = async (requests: ReferenceRequest[]) => {
  const out = new Map<string, OfficialPrice>();
  for (let index = 0; index < requests.length; index += 60) {
    const chunk = requests.slice(index, index + 60);
    const response = await fetch(`/api/polymarket/reference?keys=${encodeURIComponent(chunk.map((request) => request.key).join(","))}`, { cache: "no-store" });
    if (!response.ok) continue;
    const payload = (await response.json()) as { prices?: Record<string, unknown> };
    for (const [key, value] of Object.entries(payload.prices ?? {})) {
      const price = value && typeof value === "object" ? parseOfficialPrice(value, (value as { fetchedAt?: number }).fetchedAt ?? Date.now()) : null;
      if (price) out.set(key, price);
    }
  }
  return out;
};

/**
 * One controller per page. Components re-render at most every 250 ms (the
 * controller batches WebSocket traffic), not on every tick.
 */
export function useMarketFeed(onLog?: (level: "info" | "warn" | "error", message: string) => void) {
  const [version, setVersion] = useState(0);
  // Constructing the controller is side-effect free; sockets and timers start in the effect.
  const [controller] = useState(
    () =>
      new MarketFeedController({
        referenceFetcher: fetchReferences,
        onChange: () => setVersion((current) => current + 1),
      }),
  );
  useEffect(() => {
    controller.setLogger(onLog);
  }, [controller, onLog]);
  useEffect(() => {
    controller.start();
    const wake = () => {
      if (document.visibilityState === "visible") void controller.refresh();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      controller.stop();
    };
  }, [controller]);
  return { controller, version };
}
