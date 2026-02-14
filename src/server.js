import { main } from "./bootstrap.js";

main().catch((error) => {
  process.stderr.write(`[agent-pa] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
