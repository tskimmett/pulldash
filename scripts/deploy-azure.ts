// Builds the browser app and deploys it to an Azure Static Web App.
// Requires `az login` and these env vars (Bun loads them from .env):
//   AZURE_SUBSCRIPTION, SWA_RESOURCE_GROUP, SWA_APP_NAME
import { $ } from "bun";

const { AZURE_SUBSCRIPTION, SWA_RESOURCE_GROUP, SWA_APP_NAME } = process.env;
if (!AZURE_SUBSCRIPTION || !SWA_RESOURCE_GROUP || !SWA_APP_NAME) {
  throw new Error(
    "Set AZURE_SUBSCRIPTION, SWA_RESOURCE_GROUP and SWA_APP_NAME (e.g. in .env)"
  );
}

await $`bun run build:browser`;

const token = (
  await $`az staticwebapp secrets list -n ${SWA_APP_NAME} -g ${SWA_RESOURCE_GROUP} --subscription ${AZURE_SUBSCRIPTION} --query properties.apiKey -o tsv`.text()
).trim();
if (!token) {
  throw new Error("Could not fetch the Static Web App deployment token");
}

// Pinned: this tool receives the deploy token and uploads the bundle.
await $`bunx --bun @azure/static-web-apps-cli@2.0.10 deploy ./dist/browser --env production --no-use-keychain`.env(
  { ...process.env, SWA_CLI_DEPLOYMENT_TOKEN: token }
);
