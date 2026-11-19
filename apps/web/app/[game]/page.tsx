import { notFound } from "next/navigation";
import { catalog, findCatalogEntry } from "../../src/catalog";
import { GameClient } from "./GameClient";

export const dynamicParams = false;

export const generateStaticParams = () => catalog.map((g) => ({ game: g.slug }));

export async function generateMetadata({ params }: { params: Promise<{ game: string }> }) {
  const entry = findCatalogEntry((await params).game);
  return entry ? { title: entry.title, description: entry.description } : {};
}

export default async function GamePage({ params }: { params: Promise<{ game: string }> }) {
  const { game } = await params;
  if (!findCatalogEntry(game)) notFound();
  return <GameClient slug={game} />;
}
