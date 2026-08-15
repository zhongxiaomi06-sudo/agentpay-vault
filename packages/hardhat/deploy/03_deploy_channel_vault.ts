import { deployScript, artifacts } from "../rocketh/deploy.js";

/**
 * Deploys ChannelVault —— EIP-712 voucher 按次计量支付通道
 */
export default deployScript(
  async env => {
    const { deployer } = env.namedAccounts;

    const vault = await env.deploy("ChannelVault", {
      account: deployer,
      artifact: artifacts.ChannelVault,
      args: [],
    });

    const nonce = await env.read(vault, { functionName: "channelNonce" });
    console.log("🎫 ChannelVault deployed, channelNonce =", nonce);
  },
  {
    tags: ["ChannelVault"],
  },
);
