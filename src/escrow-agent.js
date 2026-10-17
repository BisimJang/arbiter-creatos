import { CreateOSClient } from "./sandbox-client.js";
import { StripeEscrowManager } from "./stripe-escrow.js";

/**
 * Autonomous Milestone Escrow Arbiter Agent
 * Evaluates developer deliverables in CreateOS Sandboxes and orchestrates Stripe payments
 */
export class MilestoneEscrowAgent {
  constructor(options = {}) {
    this.createos = new CreateOSClient(options.createosApiKey);
    this.stripeEscrow = new StripeEscrowManager(options.stripeApiKey);
    this.sandboxId = null;
  }

  /**
   * Initialize or attach to a sandbox
   */
  async setupSandbox(preferredId = null) {
    if (preferredId) {
      this.sandboxId = preferredId;
      console.log(`\n🛡️ [Agent] Attached to existing CreateOS Sandbox: ${this.sandboxId}`);
      return this.sandboxId;
    }

    const list = await this.createos.listSandboxes();
    const active = list.find((s) => s.status === "running");
    if (active) {
      this.sandboxId = active.id;
      console.log(`\n🛡️ [Agent] Using active CreateOS Sandbox: ${this.sandboxId} (${active.name}, ${active.shape})`);
    } else {
      console.log(`\n🛡️ [Agent] Provisioning fresh CreateOS Sandbox (s-1vcpu-1gb, devbox:1)...`);
      const created = await this.createos.createSandbox({
        shape: "s-1vcpu-1gb",
        rootfs: "devbox:1",
        name: `escrow-${Date.now().toString(36)}`,
      });
      this.sandboxId = created.id;
      console.log(`\n🛡️ [Agent] Sandbox ready in ${created.spawn_ms || 30}ms: ${this.sandboxId}`);
    }
    return this.sandboxId;
  }

  /**
   * Run verification of submitted code against acceptance criteria
   */
  async verifyDeliverable({
    milestone,
    deliverableCode,
    testHarnessCode,
    codeFilename,
    testFilename,
    releasePayout = false,
  }) {
    if (!this.sandboxId) {
      await this.setupSandbox();
    }

    console.log(`\n=================================================================`);
    console.log(`🤖 [Agent Review] Evaluating Submission for Milestone: "${milestone.title}"`);
    console.log(`=================================================================`);

    const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const workspaceDir = `/workspace/milestone_${milestone.id}_${runId}`;
    const codePath = `${workspaceDir}/${codeFilename}`;
    const testPath = `${workspaceDir}/${testFilename}`;

    console.log(`📂 [Sandbox File Transfer] Mounting deliverable code to ${codePath}...`);
    await this.createos.uploadFile(this.sandboxId, codePath, deliverableCode);

    console.log(`📂 [Sandbox File Transfer] Mounting acceptance test suite to ${testPath}...`);
    await this.createos.uploadFile(this.sandboxId, testPath, testHarnessCode);

    console.log(`⚡ [Sandbox Execution] Running test suite inside isolated Linux micro-VM...`);
    const execStartTime = Date.now();
    
    // Run tests in sandbox
    const runnerCommand = codeFilename.endsWith(".py")
      ? ["python3", "-m", "pytest", "-v", testPath]
      : ["node", "--test", "--test-reporter=tap", testPath];

    const result = await this.createos.exec(
      this.sandboxId,
      runnerCommand[0],
      runnerCommand.slice(1)
    );

    const durationMs = Date.now() - execStartTime;
    console.log(`\n📊 [Sandbox Result] Completed in ${durationMs}ms with Exit Code: ${result.exitCode}`);

    if (result.stdout) {
      console.log(`\n--- [Sandbox Standard Output] ---`);
      console.log(result.stdout.trim());
    }
    if (result.stderr && result.exitCode !== 0) {
      console.log(`\n--- [Sandbox Standard Error] ---`);
      console.log(result.stderr.trim());
    }

    // Decision Logic
    if (result.exitCode === 0) {
      console.log(`\n🎉 [VERDICT: APPROVED]`);
      console.log(`All acceptance tests passed. Code satisfies the milestone specification.`);

      const payout = releasePayout
        ? await this.stripeEscrow.releaseEscrowPayout(
            milestone.id,
            milestone.developerAccount || "acct_dev_test_42"
          )
        : null;
      if (!releasePayout) console.log("Test result recorded. No escrow payout was requested.");

      return {
        decision: "APPROVED",
        exitCode: 0,
        logs: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        payout,
        certificate: {
          milestoneId: milestone.id,
          verifiedAt: new Date().toISOString(),
          sandboxId: this.sandboxId,
          testSuite: testFilename,
          status: "PASSED",
        },
      };
    } else {
      console.log(`\n❌ [VERDICT: REJECTED]`);
      console.log(`Deliverable failed acceptance assertions.`);

      const diagnosticReport = this.generateDiagnosticReport(milestone, result.stdout || result.stderr);
      console.log(`\n📋 [Agent Diagnostics Feedback for Developer]:\n${diagnosticReport}`);

      return {
        decision: "REJECTED",
        exitCode: result.exitCode,
        logs: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        payout: null,
        feedback: diagnosticReport,
      };
    }
  }

  /**
   * Synthesize diagnostic feedback when tests fail
   */
  generateDiagnosticReport(milestone, rawLogs) {
    const logs = typeof rawLogs === "string" ? rawLogs : "";
    return [
      `Milestone: ${milestone.title}`,
      `Acceptance Criteria: ${milestone.criteria}`,
      `Issue Detected:`,
      `The deliverable failed test assertions in the sandbox environment.`,
      `Logs Summary:`,
      logs.slice(0, 500) + (logs.length > 500 ? "... [truncated]" : ""),
      `Recommended Action: Fix the failing cases and resubmit. Passing tests approve the code; payment is not connected.`
    ].join("\n");
  }

  /**
   * Neutral Dispute Arbitration Summary
   */
  generateDisputeSummary(milestone, submissionCode, testLogs) {
    const passed = testLogs.match(/^\s*# pass (\d+)/m)?.[1];
    const failed = testLogs.match(/^\s*# fail (\d+)/m)?.[1];
    const outcome = passed === undefined || failed === undefined
      ? "No TAP summary was available."
      : Number(failed) === 0
        ? `${passed} acceptance tests passed.`
        : `${failed} acceptance test(s) failed; ${passed} passed.`;

    return `
=================================================================
⚖️ ARBITER TEST REPORT
=================================================================
Task: ${milestone.title}
Listed reward: $${(milestone.amountCents / 100).toFixed(2)} ${milestone.currency || "USD"}
Payment status: Not connected. No funds were collected or released.

1. REQUIREMENTS:
   "${milestone.criteria}"

2. VERIFICATION PROTOCOL:
   CreateOS sandbox: ${this.sandboxId || "not available"}
   Test suite: ${milestone.testFilename || "acceptance tests"}

3. TEST RESULT:
   ${outcome}
   ${testLogs.slice(0, 1000)}${testLogs.length > 1000 ? "... [truncated]" : ""}

4. SUBMISSION:
   ${submissionCode.length} characters received.
=================================================================
`;
  }
}
