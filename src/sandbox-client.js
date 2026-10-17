import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Robust CreateOS Sandbox Client
 * Interacts with https://api.sb.createos.sh/v1 using native fetch
 */
export class CreateOSClient {
  constructor(apiKey) {
    this.apiKey = apiKey || this.resolveApiKey();
    this.baseUrl = process.env.CREATEOS_SANDBOX_BASE_URL || "https://api.sb.createos.sh";
  }

  resolveApiKey() {
    if (process.env.CREATEOS_SANDBOX_API_KEY) return process.env.CREATEOS_SANDBOX_API_KEY;
    if (process.env.CREATEOS_API_KEY) return process.env.CREATEOS_API_KEY;
    const tokenFile = path.join(os.homedir(), ".createos", ".token");
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, "utf-8").trim();
    }
    throw new Error("CreateOS API key not found. Please run 'createos login' or set CREATEOS_SANDBOX_API_KEY.");
  }

  get headers() {
    return {
      "X-Api-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  /**
   * List all running sandboxes
   */
  async listSandboxes() {
    const res = await fetch(`${this.baseUrl}/v1/sandboxes`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`Failed to list sandboxes: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    return json.data?.data || [];
  }

  /**
   * Create an isolated micro-VM sandbox
   */
  async createSandbox(options = {}) {
    const payload = {
      shape: options.shape || "s-1vcpu-1gb",
      rootfs: options.rootfs || "devbox:1",
      name: options.name || `agent-${Date.now().toString(36)}`,
      ingress_enabled: Boolean(options.ingressEnabled),
    };

    const res = await fetch(`${this.baseUrl}/v1/sandboxes`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Failed to create sandbox: ${res.status} ${await res.text()}`);
    }

    const json = await res.json();
    return json.data;
  }

  /**
   * Execute a command inside the sandbox and return stdout, stderr, and exit code
   */
  async exec(sandboxId, command, args = []) {
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}/exec`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        cmd: command,
        args: args,
      }),
    });

    if (!res.ok) {
      throw new Error(`Sandbox exec failed: ${res.status} ${await res.text()}`);
    }

    const json = await res.json();
    const result = json.data?.result || json.data || {};
    const exitCode = typeof result.exit_code === "number" ? result.exit_code : result.exitCode;
    if (typeof exitCode !== "number") {
      throw new Error("Sandbox command returned no exit code.");
    }
    return {
      stdout: result.stdout || result.standard_output || "",
      stderr: result.stderr || result.standard_error || "",
      exitCode,
      execMs: json.data?.exec_ms,
    };
  }

  /**
   * Upload file content into the sandbox
   */
  async uploadFile(sandboxId, filePath, content) {
    // Write via base64 in sandbox command for 100% reliable execution
    const base64 = Buffer.from(content).toString("base64");
    const dir = path.posix.dirname(filePath);
    const script = `mkdir -p "${dir}" && echo "${base64}" | base64 -d > "${filePath}"`;
    const result = await this.exec(sandboxId, "bash", ["-c", script]);
    if (result.exitCode !== 0) {
      throw new Error(`Sandbox file upload failed for ${filePath}: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  /**
   * Clean up and destroy the sandbox
   */
  async destroy(sandboxId) {
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: this.headers,
    });
    return res.ok;
  }
}
