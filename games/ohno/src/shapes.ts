import { useCallback, useEffect, useState } from "react";

const SHAPES_KEY = "ohno:shapes";

/** "Colour shapes" is a per-browser preference; storage may be missing or blocked. */
export function useShapes() {
  const [shapes, setShapes] = useState(false);
  useEffect(() => {
    try {
      setShapes(window.localStorage.getItem(SHAPES_KEY) === "1");
    } catch {
      // No storage: the default stays.
    }
  }, []);
  const update = useCallback((on: boolean) => {
    setShapes(on);
    try {
      window.localStorage.setItem(SHAPES_KEY, on ? "1" : "0");
    } catch {
      // Not saved; still applies for this visit.
    }
  }, []);
  return [shapes, update] as const;
}
