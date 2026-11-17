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
      <label htmlFor="ttt-turn-time" className="mb-1 block text-sm">
        Turn timer
      </label>
      <select
        id="ttt-turn-time"
        className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
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
