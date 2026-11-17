import { startRelay } from "./server";

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const env = process.env;
const allowedOrigins = list(env.ALLOWED_ORIGINS);
const allowedGames = list(env.ALLOWED_GAMES);

const relay = await startRelay({
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? "0.0.0.0",
  ...(allowedOrigins && { allowedOrigins }),
  ...(allowedGames && { allowedGames }),
  ...(env.MAX_CONN_PER_IP && { maxConnectionsPerIp: Number(env.MAX_CONN_PER_IP) }),
  trustProxy: env.TRUST_PROXY === "1",
});

console.log(
  `relay listening on :${relay.port} (origins: ${allowedOrigins?.join(",") ?? "any"}, games: ${allowedGames?.join(",") ?? "any"})`,
);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  relay.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
