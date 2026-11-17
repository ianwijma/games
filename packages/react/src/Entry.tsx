"use client";
import { useEffect, useState } from "react";
import { cleanCodeInput, parseCode } from "./code";
import { Button, cardClass, inputClass } from "./ui";

const NAME_KEY = "games:name";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveName = (name: string) => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // private mode: the name is just not remembered
  }
};

export interface EntryProps {
  title: string;
  description: string;
  online: boolean;
  /** Offer in-browser play without a relay. Only useful for games one player can play. */
  solo: boolean;
  prefillCode: string;
  error: string | null;
  onCreate(name: string): void;
  onJoin(name: string, code: string): void;
  onLocal(name: string): void;
}

export function Entry(props: EntryProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(cleanCodeInput(props.prefillCode));
  const [touched, setTouched] = useState(false);

  useEffect(() => setName(readName()), []);
  useEffect(() => setCode(cleanCodeInput(props.prefillCode)), [props.prefillCode]);

  const trimmed = name.trim();
  const parsed = parseCode(code);
  const go = (fn: () => void) => {
    setTouched(true);
    if (trimmed === "") return;
    saveName(trimmed);
    fn();
  };

  return (
    <div className={`mx-auto w-full max-w-md space-y-5 ${cardClass}`}>
      <div>
        <h1 className="text-2xl font-semibold">{props.title}</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{props.description}</p>
      </div>
      {props.error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {props.error}
        </p>
      )}
      <div>
        <label htmlFor="games-name" className="mb-1 block text-sm font-medium">
          Your name
        </label>
        <input
          id="games-name"
          className={inputClass}
          value={name}
          maxLength={24}
          autoComplete="nickname"
          aria-invalid={touched && trimmed === ""}
          onChange={(e) => setName(e.target.value)}
        />
        {touched && trimmed === "" && (
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">Enter a name first.</p>
        )}
      </div>
      {props.online && (
        <>
          <Button
            variant="primary"
            className="w-full"
            onClick={() => go(() => props.onCreate(trimmed))}
          >
            Create game
          </Button>
          <form
            className="space-y-2 border-t border-neutral-200 pt-4 dark:border-neutral-800"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsed) go(() => props.onJoin(trimmed, parsed));
            }}
          >
            <label htmlFor="games-code" className="block text-sm font-medium">
              Invite code
            </label>
            <div className="flex gap-2">
              <input
                id="games-code"
                className={`${inputClass} font-mono uppercase tracking-widest`}
                value={code}
                placeholder="ABC234"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCode(cleanCodeInput(e.target.value))}
              />
              <Button type="submit" disabled={!parsed}>
                Join
              </Button>
            </div>
          </form>
        </>
      )}
      {props.solo && (
        <div className="border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <Button className="w-full" onClick={() => go(() => props.onLocal(trimmed))}>
            Play on this device
          </Button>
        </div>
      )}
      {!props.online && !props.solo && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400" role="status">
          Multiplayer is not available right now.
        </p>
      )}
    </div>
  );
}
