import Link from "next/link";
import { catalog } from "../src/catalog";
import { Cover } from "./Cover";

export default function Home() {
  return (
    <div className="shelf-wrap">
      <div>
        <h1 className="felt-title">Games</h1>
        <p className="mt-1">Pick a game, share the code, play.</p>
      </div>
      <div className="felt-label">On the table</div>
      <ul className="shelf">
        {catalog.map((game) => (
          <li key={game.slug}>
            <Link href={`/${game.slug}/`} className="box">
              <Cover slug={game.slug} />
              <div className="info">
                <h2>{game.title}</h2>
                <p>{game.description}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
