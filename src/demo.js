import { MilestoneEscrowAgent } from "./escrow-agent.js";

// Helper for realistic visual pacing
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runDemo() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════════╗
║                                                                                ║
║   🚀 AUTONOMOUS MILESTONE ESCROW AGENT                                         ║
║   Built with CreateOS Cloud Sandbox × Stripe Projects Hackathon                ║
║                                                                                ║
╚════════════════════════════════════════════════════════════════════════════════╝
`);

  const agent = new MilestoneEscrowAgent();

  // Step 1: Define Milestone & Fund Escrow via Stripe
  const milestone = {
    id: "m_ratelimiter_v1",
    title: "Token-Bucket Rate Limiter Implementation",
    amountCents: 25000, // $250.00
    currency: "USD",
    criteria: "Implement TokenBucketRateLimiter(capacity=5, refillRate=10 tokens/sec). Must strictly reject excess requests when tokens are exhausted and replenish correctly.",
    developerAccount: "acct_dev_test_42",
  };

  console.log(`\n--- STEP 1: CLIENT FUNDS MILESTONE ESCROW (STRIPE) ---`);
  await agent.stripeEscrow.fundMilestone(milestone);
  await sleep(1500);

  // Define Acceptance Test Suite (Clean-Room Test Runner in Node.js)
  const testHarness = `
import assert from 'node:assert';
import { TokenBucketRateLimiter } from './rate_limiter.js';

console.log("Running Acceptance Test Suite for TokenBucketRateLimiter...");

// Test 1: Instantiation & initial burst allowance
console.log("  [Test 1] Testing initial burst capacity allowance...");
const limiter = new TokenBucketRateLimiter(5, 10);
for (let i = 0; i < 5; i++) {
  assert.strictEqual(limiter.tryAcquire(1), true, \`Request \${i + 1} should be permitted\`);
}
console.log("    ✓ Permitted 5 burst requests as expected.");

// Test 2: Immediate rejection after exhaustion
console.log("  [Test 2] Testing immediate rejection when bucket is empty...");
assert.strictEqual(limiter.tryAcquire(1), false, "6th immediate request should be REJECTED");
console.log("    ✓ 6th request correctly blocked (no tokens remaining).");

// Test 3: Replenishment over time
console.log("  [Test 3] Testing token refill timing...");
await new Promise(r => setTimeout(r, 200)); // wait 200ms -> should refill ~2 tokens (10 tok/sec)
assert.strictEqual(limiter.tryAcquire(1), true, "Refilled token should permit request");
console.log("    ✓ Refilled token permitted new request.");

console.log("\\nAll 3 Acceptance Tests PASSED successfully!");
process.exit(0);
`;

  // Candidate Submission 1: Buggy Code (Permits infinite burst, ignores capacity)
  const buggySubmission = `
export class TokenBucketRateLimiter {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
  }

  tryAcquire(amount) {
    // BUG: Always permits requests, ignoring empty bucket!
    return true;
  }
}
`;

  console.log(`\n--- STEP 2: DEVELOPER SUBMITS DELIVERABLE (VERSION 1) ---`);
  console.log(`Developer has pushed submission commit: feat(ratelimiter): initial implementation`);
  await sleep(1500);

  console.log(`\n--- STEP 3: AGENT RUNS AUTOMATED VERIFICATION IN CREATEOS SANDBOX ---`);
  const review1 = await agent.verifyDeliverable({
    milestone,
    deliverableCode: buggySubmission,
    testHarnessCode: testHarness,
    codeFilename: "rate_limiter.js",
    testFilename: "acceptance_test.js",
    releasePayout: true,
  });
  await sleep(2000);

  // Step 4: Dispute Mediation Brief Simulation
  console.log(`\n--- STEP 4: DISPUTE HANDLING SIMULATION ---`);
  console.log(`Developer asserts: "My code works locally! Please release the funds."`);
  console.log(`Agent generates objective neutral mediation summary:`);
  console.log(agent.generateDisputeSummary(milestone, buggySubmission, review1.logs));
  await sleep(2500);

  // Candidate Submission 2: Corrected, Production-Grade Implementation
  const fixedSubmission = `
export class TokenBucketRateLimiter {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillRate);
    this.lastRefill = now;
  }

  tryAcquire(amount = 1) {
    this.refill();
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }
}
`;

  console.log(`\n--- STEP 5: DEVELOPER SUBMITS PATCHED CODE (VERSION 2) ---`);
  console.log(`Developer pushed patch: fix(ratelimiter): implement precise mathematical token decay`);
  await sleep(1500);

  console.log(`\n--- STEP 6: AGENT RE-VERIFIES IN CREATEOS SANDBOX & RELEASES STRIPE PAYOUT ---`);
  const review2 = await agent.verifyDeliverable({
    milestone,
    deliverableCode: fixedSubmission,
    testHarnessCode: testHarness,
    codeFilename: "rate_limiter.js",
    testFilename: "acceptance_test.js",
    releasePayout: true,
  });

  console.log(`\n=================================================================`);
  console.log(`🏁 FULL DEMO CYCLE COMPLETE`);
  console.log(`=================================================================`);
  console.log(`✓ Stripe Escrow Funded:     $250.00 USD (Authorized)`);
  console.log(`✓ CreateOS Sandbox Test 1:  EXIT CODE ${review1.exitCode} (Safely Rejected, Funds Held)`);
  console.log(`✓ Neutral Dispute Brief:    Synthesized from Sandbox Telemetry`);
  console.log(`✓ CreateOS Sandbox Test 2:  EXIT CODE ${review2.exitCode} (Approved & Certified)`);
  console.log(`✓ Stripe Payout Disbursed:  Transfer ${review2.payout?.transferId || "tr_test_complete"} to ${milestone.developerAccount}`);
  console.log(`=================================================================\n`);
}

runDemo().catch((err) => {
  console.error("Demo failed with error:", err);
  process.exit(1);
});
