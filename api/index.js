import { createHandler } from "../src/server.js";
import { MilestoneEscrowAgent } from "../src/escrow-agent.js";
import { TaskStore } from "../src/tasks.js";

const agent = new MilestoneEscrowAgent();
const taskStore = new TaskStore();
let lastReview = null;

const handler = createHandler({
  agent,
  taskStore,
  getEscrowRecord: () => null,
  getLastReview: () => lastReview,
  setLastReview: (r) => { lastReview = r; }
});

export default handler;
