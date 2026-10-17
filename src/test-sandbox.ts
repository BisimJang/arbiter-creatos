import { createClient } from "@nodeops-createos/sandbox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import dotenv from "dotenv";

dotenv.config();

function getApiKey(): string {
  if (process.env.CREATEOS_SANDBOX_API_KEY) {
    return process.env.CREATEOS_SANDBOX_API_KEY;
  }
  if (process.env.CREATEOS_API_KEY) {
    return process.env.CREATEOS_API_KEY;
  }
  const tokenPath = path.join(os.homedir(), ".createos", ".token");
  if (fs.existsSync(tokenPath)) {
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    if (token) return token;
  }
  throw new Error("No CreateOS API key found in env or ~/.createos/.token");
}

async function main() {
  const apiKey = getApiKey();
  console.log("Found CreateOS API Key (length:", apiKey.length, ")");
  
  const client = createClient({ apiKey });
  console.log("Connecting to CreateOS Sandbox client...");
  
  const sandboxes = await client.listSandboxes();
  console.log(`Discovered ${sandboxes.length} active sandbox(es):`);
  for (const sb of sandboxes) {
    console.log(` - [${sb.id}] ${sb.name} (${sb.shape}) status: ${sb.status}`);
  }
}

main().catch(console.error);
