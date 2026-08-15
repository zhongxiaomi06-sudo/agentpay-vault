import { deployScript, artifacts } from "../rocketh/deploy.js";

/**
 * Deploys AgentPayVault —— AI Agent 微支付结算层（流支付 + 按次付费 + Escrow）
 */
export default deployScript(
  async env => {
    const { deployer } = env.namedAccounts;

    const vault = await env.deploy("AgentPayVault", {
      account: deployer,
      artifact: artifacts.AgentPayVault,
      args: [],
    });

    const planCount = await env.read(vault, { functionName: "planCount" });
    console.log("💰 AgentPayVault deployed, planCount =", planCount);
  },
  {
    tags: ["AgentPayVault"],
  },
);
