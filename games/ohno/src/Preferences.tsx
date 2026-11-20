"use client";
import { OhnoCard } from "./Card";
import { useShapes } from "./shapes";

/** The player's own options, shown in the lobby. Kept in this browser, never sent to the room. */
export function Preferences() {
  const [shapes, setShapes] = useShapes();
  return (
    <div className="ohno-rule ohno-pref">
      <input
        id="ohno-pref-shapes"
        type="checkbox"
        checked={shapes}
        aria-describedby="ohno-pref-shapes-detail"
        onChange={(e) => setShapes(e.target.checked)}
      />
      <div>
        <label htmlFor="ohno-pref-shapes">Show a shape on each colour</label>
        <p id="ohno-pref-shapes-detail" className="muted">
          Helps if the four colours are hard to tell apart. Only you see it.
        </p>
      </div>
      <OhnoCard card={{ id: "sample", color: "blue", value: "7" }} shapes={shapes} decorative />
    </div>
  );
}
