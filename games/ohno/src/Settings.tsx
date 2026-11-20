"use client";
import type { Config, Goal, HouseRules } from "./types";
import { TURN_OPTIONS } from "./types";

const POINT_TARGETS = [100, 200, 300, 500, 1000];
const ROUND_TARGETS = [1, 3, 5, 10];

const RULES: { key: keyof HouseRules; title: string; detail: string }[] = [
  {
    key: "stackDrawTwo",
    title: "Stack +2",
    detail: "Answer a +2 with another +2; the first player who cannot takes them all.",
  },
  {
    key: "drawUntilPlayable",
    title: "Draw until playable",
    detail: "Keep drawing until a card you can play turns up.",
  },
  {
    key: "mustPlayDrawn",
    title: "Play the card you draw",
    detail: "If the card you draw can be played, you have to play it.",
  },
  {
    key: "callPenalty",
    title: "Catch a missed Oh no!",
    detail: "Anyone can catch a player on one card who forgot to call, and they draw two.",
  },
  {
    key: "challengeWildFour",
    title: "Challenge a +4",
    detail:
      "The player hit by a +4 may challenge it. If the one who played it also held a card in the colour to match, they draw the four instead. If not, the challenger draws six.",
  },
];

function targetOptions(goal: Goal): number[] {
  const base = goal.mode === "points" ? POINT_TARGETS : ROUND_TARGETS;
  return base.includes(goal.target) ? base : [...base, goal.target].sort((a, b) => a - b);
}

export function Settings({
  config,
  onChange,
  disabled,
}: {
  config: Config;
  onChange(config: Config): void;
  disabled: boolean;
}) {
  const { goal } = config;
  return (
    <div className="stack">
      <div>
        <label htmlFor="ohno-turn-time">Turn timer</label>
        <select
          id="ohno-turn-time"
          disabled={disabled}
          value={config.turnSeconds}
          onChange={(e) =>
            onChange({ ...config, turnSeconds: Number(e.target.value) as Config["turnSeconds"] })
          }
        >
          {TURN_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds === 0 ? "No timer" : `${seconds} seconds`}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="ohno-goal-mode">The match is won by</label>
        <select
          id="ohno-goal-mode"
          disabled={disabled}
          value={goal.mode}
          onChange={(e) => {
            const mode = e.target.value === "rounds" ? "rounds" : "points";
            onChange({ ...config, goal: { mode, target: mode === "points" ? 500 : 3 } });
          }}
        >
          <option value="points">Reaching a score</option>
          <option value="rounds">Winning rounds</option>
        </select>
      </div>

      <div>
        <label htmlFor="ohno-goal-target">
          {goal.mode === "points" ? "Points to win" : "Rounds to win"}
        </label>
        <select
          id="ohno-goal-target"
          disabled={disabled}
          value={goal.target}
          onChange={(e) =>
            onChange({ ...config, goal: { ...goal, target: Number(e.target.value) } })
          }
        >
          {targetOptions(goal).map((target) => (
            <option key={target} value={target}>
              {target}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="ohno-rules" disabled={disabled}>
        <legend>House rules</legend>
        {RULES.map((rule) => {
          const id = `ohno-rule-${rule.key}`;
          return (
            <div key={rule.key} className="ohno-rule">
              <input
                id={id}
                type="checkbox"
                checked={config.rules[rule.key]}
                aria-describedby={`${id}-detail`}
                onChange={(e) =>
                  onChange({ ...config, rules: { ...config.rules, [rule.key]: e.target.checked } })
                }
              />
              <div>
                <label htmlFor={id}>{rule.title}</label>
                <p id={`${id}-detail`} className="muted">
                  {rule.detail}
                </p>
              </div>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}
