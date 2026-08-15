import { wagmiConnectors } from "./wagmiConnectors";
import { Chain, createClient, fallback, http } from "viem";
import { hardhat, mainnet } from "viem/chains";
import { createConfig } from "wagmi";
import scaffoldConfig, { DEFAULT_ALCHEMY_API_KEY, ScaffoldConfig } from "~~/scaffold.config";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth";

const { targetNetworks } = scaffoldConfig;
const monadHttp = (url?: string) => http(url, { batch: { batchSize: 10, wait: 25 }, retryCount: 0, timeout: 12_000 });

// We always want to have mainnet enabled (ENS resolution, ETH price, etc). But only once.
export const enabledChains = targetNetworks.find((network: Chain) => network.id === 1)
  ? targetNetworks
  : ([...targetNetworks, mainnet] as const);

export const wagmiConfig = createConfig({
  chains: enabledChains,
  connectors: wagmiConnectors(),
  ssr: true,
  client({ chain }) {
    // Extra fallback for mainnet.
    const mainnetFallbackWithDefaultRPC = [http("https://mainnet.rpc.buidlguidl.com")];
    let rpcFallbacks = [
      ...(chain.id === mainnet.id ? mainnetFallbackWithDefaultRPC : []),
      chain.id === 10143 ? monadHttp() : http(),
    ];

    const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];

    if (rpcOverrideUrl) {
      const monadFallbacks = chain.id === 10143 ? [monadHttp("https://monad-testnet.drpc.org")] : [];
      rpcFallbacks = [
        chain.id === 10143 ? monadHttp(rpcOverrideUrl) : http(rpcOverrideUrl),
        ...monadFallbacks,
        ...rpcFallbacks,
      ];
    } else {
      const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
      if (alchemyHttpUrl) {
        const isUsingDefaultKey = scaffoldConfig.alchemyApiKey === DEFAULT_ALCHEMY_API_KEY;
        // If using default Scaffold-ETH 2 API key, we prioritize the default RPC
        rpcFallbacks = isUsingDefaultKey
          ? [...rpcFallbacks, http(alchemyHttpUrl)]
          : [http(alchemyHttpUrl), ...rpcFallbacks];
      }
    }

    return createClient({
      chain,
      transport: fallback(rpcFallbacks, { retryCount: 0 }),
      ...(chain.id !== (hardhat as Chain).id
        ? {
            pollingInterval: scaffoldConfig.pollingInterval,
          }
        : {}),
    });
  },
});
