import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  // Directory-style output (/tic-tac-toe/index.html) works on any plain static file server.
  trailingSlash: true,
  // Workspace packages are TypeScript source, so Next has to compile all of them (also the
  // transitive ones).
  transpilePackages: [
    "@games/react",
    "@games/tic-tac-toe",
    "@games/ohno",
    "@games/game",
    "@games/net",
    "@games/protocol",
    "@games/relay-core",
  ],
};

export default config;
