import Link from "next/link";
import { catalog } from "../src/catalog";

export default function Home() {
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Games</h1>
      <p className="mb-6 text-neutral-600 dark:text-neutral-400">
        Pick a game, share the code, play.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {catalog.map((game) => (
          <li key={game.slug}>
            <Link
              href={`/${game.slug}/`}
              className="block h-full rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm hover:border-indigo-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <h2 className="font-semibold">{game.title}</h2>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {game.description}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
