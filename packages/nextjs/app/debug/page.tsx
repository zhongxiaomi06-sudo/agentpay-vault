import { DebugContracts } from "./_components/DebugContracts";
import type { NextPage } from "next";
import { getMetadata } from "~~/utils/scaffold-eth/getMetadata";

export const metadata = getMetadata({
  title: "AgentPay Contract Console",
  description: "Inspect and interact with the AgentPay contracts deployed on the selected network.",
});

const Debug: NextPage = () => {
  return (
    <>
      <DebugContracts />
      <div className="text-center mt-8 bg-secondary text-secondary-content p-10">
        <h1 className="text-4xl my-0">AgentPay Contract Console</h1>
        <p>Inspect contract state and submit testnet transactions directly from this technical console.</p>
      </div>
    </>
  );
};

export default Debug;
