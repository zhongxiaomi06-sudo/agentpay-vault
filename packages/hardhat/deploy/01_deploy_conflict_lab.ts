import { deployScript, artifacts } from "../rocketh/deploy.js";

/**
 * Deploys ConflictLab —— ParallelLens 的链上冲突实验台
 */
export default deployScript(
  async env => {
    const { deployer } = env.namedAccounts;

    const conflictLab = await env.deploy("ConflictLab", {
      account: deployer,
      artifact: artifacts.ConflictLab,
      args: [],
    });

    const hotCounter = await env.read(conflictLab, { functionName: "hotCounter" });
    console.log("🔥 ConflictLab deployed, hotCounter =", hotCounter);
  },
  {
    tags: ["ConflictLab"],
  },
);
