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
  /** A neutral note above the form, such as "You left the game.". */
  notice?: string | null;
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

  const noRoom = props.error !== null && /no such room|room not found/i.test(props.error);
  const topError = props.error !== null && !noRoom ? props.error : null;
  const invited = props.online && props.error === null && parseCode(props.prefillCode) !== null;

  const nameField = (
    <div>
      <label htmlFor="games-name">Your name</label>
      <input
        id="games-name"
        className={inputClass}
        value={name}
        maxLength={24}
        autoComplete="nickname"
        aria-invalid={touched && trimmed === ""}
        onChange={(e) => setName(e.target.value)}
      />
      {touched && trimmed === "" && <p className="notice field">Enter a name first.</p>}
    </div>
  );

  if (invited) {
    return (
      <div className="flex flex-col gap-3">
        {props.notice && <p className="notice neutral paper narrow">{props.notice}</p>}
        <form
          className={`${cardClass} narrow flex flex-col gap-4`}
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed) go(() => props.onJoin(trimmed, parsed));
          }}
        >
          <div>
            <h1 className="text-2xl">Join {props.title}</h1>
            <p className="muted mt-1">You were invited to this game.</p>
          </div>
          <div>
            <label htmlFor="games-code">Invite code</label>
            <input id="games-code" className="code" value={code} readOnly />
          </div>
          {nameField}
          <Button type="submit" variant="primary" className="w-full">
            Join game
          </Button>
          <hr />
          <Button className="w-full" onClick={() => go(() => props.onCreate(trimmed))}>
            Create a new game instead
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {props.notice && <p className="notice neutral paper narrow">{props.notice}</p>}
      <div className={`${cardClass} narrow flex flex-col gap-4`}>
        <div>
          <h1 className="text-2xl">{props.title}</h1>
          <p className="muted mt-1">{props.description}</p>
        </div>
        {topError && (
          <p role="alert" className="notice">
            {topError}
          </p>
        )}
        {nameField}
        {props.online && (
          <>
            <Button
              variant="primary"
              className="w-full"
              onClick={() => go(() => props.onCreate(trimmed))}
            >
              Create game
            </Button>
            <hr />
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (parsed) go(() => props.onJoin(trimmed, parsed));
              }}
            >
              <label htmlFor="games-code">Invite code</label>
              <div className="flex gap-2">
                <input
                  id="games-code"
                  className={`${inputClass} code`.trim()}
                  value={code}
                  aria-invalid={noRoom}
                  aria-describedby={noRoom ? "games-code-error" : undefined}
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
              {noRoom && (
                <p id="games-code-error" role="alert" className="notice field">
                  Room not found. Check the six-character code or ask for a new link.
                </p>
              )}
            </form>
          </>
        )}
        {props.solo && (
          <>
            <hr />
            <Button className="w-full" onClick={() => go(() => props.onLocal(trimmed))}>
              Play on this device
            </Button>
          </>
        )}
        {!props.online && !props.solo && (
          <p className="muted" role="status">
            Multiplayer is not available right now.
          </p>
        )}
      </div>
    </div>
  );
}
