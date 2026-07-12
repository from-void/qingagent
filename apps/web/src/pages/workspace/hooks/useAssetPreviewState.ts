import { useEffect, useState } from "react";
import type { AssetSource } from "../data/sources";

export function useAssetPreviewState() {
  const [previewSource, setPreviewSource] = useState<AssetSource | null>(null);
  const [previewExit, setPreviewExit] = useState<{
    source: AssetSource | null;
    closing: boolean;
  }>({ source: null, closing: false });

  useEffect(() => {
    if (previewSource) {
      setPreviewExit({ source: previewSource, closing: false });
      return;
    }
    setPreviewExit((current) =>
      current.source ? { source: current.source, closing: true } : current,
    );
    const timer = setTimeout(
      () => setPreviewExit({ source: null, closing: false }),
      200,
    );
    return () => clearTimeout(timer);
  }, [previewSource]);

  useEffect(() => {
    if (!previewSource) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewSource(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewSource]);

  return { previewExit, previewSource, setPreviewSource };
}
