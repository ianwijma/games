"use client";
import type { Config } from "./game";
import { TURN_OPTIONS } from "./game";

export function Settings({
  config,
  onChange,
  disabled,
}: {
  config: Config;
  onChange(config: Config): void;
  disabled: boolean;
}) {
  return (
    <div>
      <label htmlFor="ttt-turn-time">Turn timer</label>
      <select
        id="ttt-turn-time"
        disabled={disabled}
        value={config.turnSeconds}
        onChange={(e) => onChange({ turnSeconds: Number(e.target.value) as Config["turnSeconds"] })}
      >
        {TURN_OPTIONS.map((seconds) => (
          <option key={seconds} value={seconds}>
            {seconds === 0 ? "No timer" : `${seconds} seconds`}
          </option>
        ))}
      </select>
    </div>
  );
}
