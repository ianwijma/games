import { startRelay } from "./server";

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const env = process.env;
const allowedOrigins = list(env.ALLOWED_ORIGINS);
const allowedGames = list(env.ALLOWED_GAMES);
const clientIpHeader = env.CLIENT_IP_HEADER?.trim() || undefined;
// Hop count. TRUST_PROXY=1 keeps its old meaning (one proxy, last X-Forwarded-For entry).
const trustProxy = Number(env.TRUST_PROXY || 0);
const stateFile = env.STATE_FILE?.trim() || undefined;
const snapshotIntervalMs = env.SNAPSHOT_INTERVAL_MS?.trim()
  ? Number(env.SNAPSHOT_INTERVAL_MS)
  : 5000;
if (!Number.isInteger(snapshotIntervalMs) || snapshotIntervalMs <= 0) {
  console.error(
    `relay: SNAPSHOT_INTERVAL_MS must be a positive integer (milliseconds), got "${env.SNAPSHOT_INTERVAL_MS}"`,
  );
  process.exit(1);
}
const clientIpSource =
  clientIpHeader ?? (trustProxy > 0 ? `x-forwarded-for, ${trustProxy} proxies` : "socket");

const relay = await startRelay({
  port: Number(env.PORT ?? 6767),
  host: env.HOST ?? "0.0.0.0",
  ...(allowedOrigins && { allowedOrigins }),
  ...(allowedGames && { allowedGames }),
  ...(env.MAX_CONN_PER_IP && { maxConnectionsPerIp: Number(env.MAX_CONN_PER_IP) }),
  ...(clientIpHeader && { clientIpHeader }),
  trustProxy,
  ...(stateFile && { stateFile, snapshotIntervalMs }),
  ...(env.MAX_ROOMS && { hub: { maxRooms: Number(env.MAX_ROOMS) } }),
});

console.log(
  `relay listening on :${relay.port} (origins: ${allowedOrigins?.join(",") ?? "any"}, games: ${allowedGames?.join(",") ?? "any"}, client ip: ${clientIpSource}, state file: ${stateFile ? `${stateFile} every ${snapshotIntervalMs} ms` : "none"})`,
);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  // A second signal while this runs is ignored above, so it cannot cut the final write short.
  relay.close().then(
    () => process.exit(0),
    (error) => {
      console.error("relay: shutdown failed", error);
      process.exit(1);
    },
  );
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
