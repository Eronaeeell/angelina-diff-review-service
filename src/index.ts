import { createApp } from "./app";
import { config } from "./config";
import { startStoreSweeper } from "./jobs/store";

if (!config.bearerToken) {
  console.warn("WARNING: AUTH_TOKEN is not set -- all /v1/* requests will be rejected with 401.");
}

const app = createApp();

app.listen(config.port, () => {
  console.log(`AI diff review service listening on port ${config.port}`);
});

startStoreSweeper();
