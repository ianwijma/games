import Link from "next/link";
import { catalog } from "../src/catalog";

export default function Home() {
  return (
    <>
      <div>
        <h1 className="felt-title">Games</h1>
        <p className="mt-1">Pick a game, share the code, play.</p>
      </div>
      <div className="felt-label">On the table</div>
      <ul className="shelf">
        {catalog.map((game) => (
          <li key={game.slug}>
            <Link href={`/${game.slug}/`} className="box">
              <div className="cover">
                <div className="grid3" aria-hidden="true">
                  <b />
                  <b />
                  <b />
                  <b />
                  <b />
                  <b />
                  <b />
                  <b />
                  <b />
                </div>
              </div>
              <div className="info">
                <h2>{game.title}</h2>
                <p>{game.description}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
